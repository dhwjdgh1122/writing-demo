// Manual cross-provider diagnosis of frozen PR #48 drafts; never generates a new draft.
// Dry-run does not read .env, write reports/ledgers, or call a model.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.ts';
import { createGeminiProvider } from '../server/llm/gemini.ts';
import { createEliceProvider } from '../server/llm/elice.ts';
import { explanationsSchema, explanationsMatch } from '../shared/contracts.ts';
import { continuationInput, continuationModelInput } from './evaluate-explanation-continuation.mjs';
import { inspectContinuationLedger, reserveContinuationCall, finishContinuationCall } from './lib/model-call-continuation.mjs';

const experimentId = 'issue22-cross-review-20261122';
const providers = ['elice', 'gemini'];
const models = { elice: 'gpt-4o-mini', gemini: 'gemini-3.5-flash-lite' };
const caseIds = ['E-03', 'R-03'];
const perProviderMaxCalls = 2;
const ledgerPath = 'docs/evaluations/approved-model-calls-continuation-2026-11-22.json';
const fixturePath = 'tests/fixtures/explanation-review-cases.json';
const sourcePaths = Object.fromEntries(providers.map(provider =>
  [provider, `docs/evaluations/explanation-review-${provider}-2026-11-21.json`]));
const frozenCanonicalJsonHashes = {
  [fixturePath]: 'e7237d4cbcf1bebf8eaf5d2fa3fd89041f326e8be75eb5b1bc17413a0357a3fc',
  [sourcePaths.elice]: '3d3a5e225ab78b692b16194fcf146f1b7aa83481040bcc5a4736e4e6b7a32e8f',
  [sourcePaths.gemini]: 'e8c0a065afcd58539795686e9aaa7b4bbd3f4803bdac5495da3d2c7e4d4a2a2a',
};
const frozenInputHashes = {
  'E-03': 'abfef2f10a33e042c3b46c8c6a9b0d43d428e6016d61fc4cfc01fbe3e5affc20',
  'R-03': '27331afa4f3303970d38f768223dfa6667f668a989052ed45d4679e21873656b',
};
const frozenDraftHashes = {
  elice: { 'E-03': '72b65983ec9d24c8ba154daef613ec18d445559b2f1e0d308943fdd9124c575b',
    'R-03': 'c202dbc0fead60b0507d45dadc3a08ea820fa239dc837ce54ce7fbf0daf4fd02' },
  gemini: { 'E-03': 'aa081078168c94c4230b74cd97d92130ec5db2fa1ef32d79d0ffdc7dd522c6a3',
    'R-03': 'be32525ce5f36da92c99f84015641f8825781bdb87dcaf7cce7970b92856a1ca' },
};
const revisionPromptSha256 = 'dc2494cfbb87b98284b4241abda1157c384d8d03d808b475a66cca4b83e49eff';
const hash = value => createHash('sha256').update(value).digest('hex');
const objectHash = value => hash(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalJson = value => Array.isArray(value) ? value.map(canonicalJson)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])])) : value;
const hardFailures = ['MODEL_NOT_CONFIGURED', 'MODEL_CONFIGURATION_ERROR', 'MODEL_QUOTA_EXCEEDED',
  'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_REQUEST_FAILED'];

// Pin parsed content, preserving string/array contents but ignoring checkout
// newline/indentation and object-key order. Live reports also hash actual bytes.
export function parseFrozenCrossReviewArtifact(path, text) {
  const parsed = JSON.parse(text);
  if (!Object.hasOwn(frozenCanonicalJsonHashes, path)
    || objectHash(canonicalJson(parsed)) !== frozenCanonicalJsonHashes[path]) {
    throw new Error('Frozen PR #48 source artifact changed; preserve and review it before running.');
  }
  return parsed;
}
const frozenJson = path => parseFrozenCrossReviewArtifact(path, readFileSync(path, 'utf8'));

// The plan links only complete, schema-valid baseline RAW outputs from the other
// provider. API notices, previous revisions and fixture answers cannot be drafts.
export function buildCrossReviewPlan(reviewer, sourceReports, fixture) {
  if (!providers.includes(reviewer) || !isObject(sourceReports)
    || !Array.isArray(fixture) || fixture.length !== 2 || fixture.map(c => c.id).join(',') !== caseIds.join(',')) {
    throw new Error('Invalid frozen cross-review plan.');
  }
  const originalProvider = reviewer === 'elice' ? 'gemini' : 'elice';
  const instructions = providers.map(provider => {
    const report = sourceReports[provider];
    if (!isObject(report) || report.provider !== provider || report.model !== models[provider]
      || report.experimentId !== 'issue22-explanation-review-20261121'
      || typeof report.revisionPrompt !== 'string' || hash(report.revisionPrompt) !== revisionPromptSha256
      || report.promptSha256?.revision !== revisionPromptSha256) throw new Error('Frozen provider or revision instruction mismatch.');
    return report.revisionPrompt;
  });
  if (instructions[0] !== instructions[1]) throw new Error('Frozen revision instructions differ.');
  const origin = sourceReports[originalProvider];
  if (!Array.isArray(origin.runs) || origin.runs.filter(run => run.arm === 'baseline').length !== 2) {
    throw new Error('Expected exactly two frozen baseline drafts.');
  }
  const plan = fixture.map(c => {
    const submitted = continuationInput(c, `cross-${c.id}-${reviewer}`);
    const originalInput = { sourceText: submitted.sourceText, candidates: submitted.candidates };
    if (objectHash(originalInput) !== frozenInputHashes[c.id]) throw new Error('Frozen source or candidate changed.');
    const originalCase = origin.cases?.filter(item => item.id === c.id);
    if (originalCase?.length !== 1) throw new Error('Frozen source case is missing or ambiguous.');
    const originalSubmitted = continuationInput(originalCase[0], submitted.requestId);
    if (JSON.stringify(originalSubmitted) !== JSON.stringify(submitted)) throw new Error('Frozen report and fixture inputs differ.');
    const originals = origin.runs.filter(run => run.caseId === c.id && run.arm === 'baseline');
    if (originals.length !== 1) throw new Error('Frozen baseline is missing or duplicated.');
    const baseline = originals[0];
    if (baseline.status !== 200 || baseline.upstreamStatus !== 200 || baseline.state !== 'finished'
      || baseline.rawCompletion?.finishReason !== (originalProvider === 'gemini' ? 'STOP' : 'stop')
      || typeof baseline.rawCompletion.text !== 'string' || baseline.rawCompletion.text.length > 10000) {
      throw new Error('Frozen baseline has no complete usable raw output.');
    }
    continuationModelInput(baseline.sentInput, submitted);
    let raw;
    try { raw = JSON.parse(baseline.rawCompletion.text); }
    catch { throw new Error('Frozen baseline is not valid JSON.'); }
    if (!isObject(raw) || Object.keys(raw).join(',') !== 'explanations') throw new Error('Frozen draft envelope contains unexpected fields.');
    const parsed = explanationsSchema.safeParse(raw.explanations);
    if (!parsed.success || !explanationsMatch(submitted.candidates, parsed.data)) throw new Error('Frozen draft schema or candidate IDs do not match.');
    const draftSha256 = objectHash(parsed.data);
    if (draftSha256 !== frozenDraftHashes[originalProvider][c.id]) throw new Error('Frozen baseline draft changed.');
    return { caseId: c.id, originalProvider, originalModel: models[originalProvider], reviewer, reviewerModel: models[reviewer],
      sourceReport: sourcePaths[originalProvider], sourceReportCanonicalJsonSha256: frozenCanonicalJsonHashes[sourcePaths[originalProvider]],
      originalCallId: baseline.callId, originalStartedAt: baseline.startedAt,
      originalCodeCommit: origin.codeCommit, submittedInput: submitted,
      draftExplanations: structuredClone(parsed.data), draftSha256 };
  });
  return { instruction: instructions[0], revisionPromptSha256, originalProvider, plan };
}

// Verify provider input before appending only the already-linked draft. No
// per-case criteria or origin metadata are part of the model-facing payload.
export function crossReviewModelInput(input, submittedInput, draftExplanations, draftSha256) {
  const base = continuationModelInput(input, submittedInput);
  const parsed = explanationsSchema.safeParse(draftExplanations);
  if (!parsed.success || !explanationsMatch(base.candidates, parsed.data)
    || objectHash(parsed.data) !== draftSha256) throw new Error('Cross-review draft schema, ownership or frozen hash mismatch.');
  return { ...base, draftExplanations: structuredClone(parsed.data) };
}

function saveReport(path, report) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600); created = true;
    writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path); created = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) unlinkSync(temporary);
  }
}

export async function runCrossReview(args = process.argv.slice(2)) {
  if (args.some(arg => !['--provider=elice', '--provider=gemini', '--live'].includes(arg))
    || args.filter(arg => arg.startsWith('--provider=')).length !== 1 || new Set(args).size !== args.length) {
    throw new Error('Use --provider=elice|gemini [--live]. Default is dry-run.');
  }
  const reviewer = args.find(arg => arg.startsWith('--provider=')).slice('--provider='.length);
  const sourceReports = Object.fromEntries(providers.map(provider => [provider, frozenJson(sourcePaths[provider])]));
  const fixture = frozenJson(fixturePath);
  const { instruction, originalProvider, plan } = buildCrossReviewPlan(reviewer, sourceReports, fixture);
  const reportPath = `docs/evaluations/explanation-cross-review-2026-11-22-${reviewer}.json`;
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ dryRun: true, experimentId, reviewer, model: models[reviewer], originalProvider,
      plan: plan.map(({ caseId, sourceReport, sourceReportCanonicalJsonSha256, draftSha256 }) => ({ caseId, sourceReport, sourceReportCanonicalJsonSha256, draftSha256 })),
      perProviderMaxCalls, totalPlannedAcrossProviders: 4, revisionPromptSha256, frozenCanonicalJsonHashes, reportPath,
      notes: 'No .env access, writes or model calls. Only frozen baseline raw drafts; no new first generation.' }));
    return;
  }
  const ledger = inspectContinuationLedger(ledgerPath);
  if (ledger.calls.some(call => call.experimentId === experimentId && call.provider === reviewer)) {
    throw new Error('This cross-review/provider has previous attempts; preserve them instead of replaying.');
  }
  const files = [...Object.keys(frozenCanonicalJsonHashes), ledgerPath, ledger.previousLedger.path,
    'scripts/evaluate-explanation-cross-review.mjs', 'scripts/evaluate-explanation-continuation.mjs', 'scripts/lib/model-call-continuation.mjs',
    'server/llm/prompt.ts', 'server/llm/provider.ts', 'server/llm/gemini.ts', 'server/llm/elice.ts',
    'server/llm/parse-explanations.ts', 'server/llm/explanation-spacing.ts', 'server/llm/explanation-check.ts',
    'server/app.ts', 'shared/contracts.ts', 'package-lock.json'];
  const report = {
    experimentId, startedAt: new Date().toISOString(), provider: reviewer, model: models[reviewer], originalProvider,
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    implementationSha256: Object.fromEntries([...new Set(files)].map(path => [path, hash(readFileSync(path))])),
    frozenCanonicalJsonHashes, instruction, revisionPromptSha256, plan, cases: fixture, perProviderMaxCalls,
    priorAuthorization: { previousLedger: ledger.previousLedger, authorization: ledger.authorization, callsAtStart: ledger.calls.length },
    path: 'Frozen other-provider raw draft -> loopback /api/explanations -> current provider adapter with original PR #48 revision instruction -> current parser/quote guard.',
    limits: 'Historical self-review is a temporal comparison, not a simultaneous randomized control. No new baseline, product two-call pipeline, quality-gate pass or user-benefit claim.',
    notes: 'No retries, automatic provider switch or answer-field injection. Raw completion, adapter and API outputs are separate. Failed/reserved calls count.',
    modelCalls: 0, state: 'preflight', completed: false, runs: [], unexecuted: plan.map(entry => entry.caseId),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const save = () => {
    report.unexecuted = plan.filter(entry => !report.runs.some(run => run.caseId === entry.caseId && run.callId)).map(entry => entry.caseId);
    saveReport(reportPath, report);
  };
  let activeRun = null, server = null;
  const observedFetch = async (url, options) => {
    const run = activeRun;
    if (!run || run.callId || report.modelCalls >= perProviderMaxCalls) throw new Error('Unexpected additional model request.');
    const body = JSON.parse(options.body);
    const originalInput = JSON.parse(reviewer === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content);
    const sentInput = crossReviewModelInput(originalInput, run.submittedInput, run.draftExplanations, run.draftSha256);
    if (reviewer === 'gemini') {
      body.systemInstruction = { parts: [{ text: instruction }] };
      body.contents[0].parts[0].text = JSON.stringify(sentInput);
    } else {
      body.messages[0].content = instruction;
      body.messages[1].content = JSON.stringify(sentInput);
    }
    run.sentInput = structuredClone(sentInput); run.instructionSha256 = revisionPromptSha256;
    run.requestSettings = reviewer === 'gemini' ? body.generationConfig
      : { model: body.model, response_format: body.response_format, n: body.n, stream: body.stream, max_tokens: body.max_tokens };
    options.signal?.throwIfAborted();
    run.callId = reserveContinuationCall(ledgerPath, { experimentId, label: `${run.caseId}-from-${originalProvider}`,
      provider: reviewer, model: models[reviewer] }, perProviderMaxCalls);
    report.modelCalls++; run.callState = 'reserved-result-unknown'; save();
    let response;
    try { response = await fetch(url, { ...options, body: JSON.stringify(body) }); }
    catch (error) { finishContinuationCall(ledgerPath, run.callId, { status: 'failed' }); run.callState = 'fetch-failed'; save(); throw error; }
    finishContinuationCall(ledgerPath, run.callId, { status: 'received', httpStatus: response.status });
    run.callState = 'response-received'; run.upstreamStatus = response.status;
    if (response.ok) {
      try {
        const envelope = await response.clone().json();
        const respondedModel = reviewer === 'gemini' ? envelope.modelVersion : envelope.model;
        if (typeof respondedModel === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(respondedModel)
          && !/^(?:sk-|AIza)/.test(respondedModel)) run.respondedModel = respondedModel;
        run.rawCompletion = reviewer === 'gemini'
          ? { finishReason: envelope.candidates?.[0]?.finishReason,
            text: envelope.candidates?.[0]?.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('') ?? null }
          : { finishReason: envelope.choices?.[0]?.finish_reason, text: envelope.choices?.[0]?.message?.content ?? null };
        run.rawCompletionTextAvailable = typeof run.rawCompletion.text === 'string';
        if (run.rawCompletionTextAvailable) {
          try { run.parsedModelOutput = JSON.parse(run.rawCompletion.text); }
          catch { run.rawParseError = 'completion-is-not-valid-json'; }
        } else run.rawParseError = 'no-completion-text';
        const usage = reviewer === 'gemini' ? envelope.usageMetadata : envelope.usage;
        const keys = reviewer === 'gemini' ? ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
          : ['prompt_tokens', 'completion_tokens', 'total_tokens'];
        run.tokenUsage = Object.fromEntries(keys.filter(key => Number.isFinite(usage?.[key])).map(key => [key, usage[key]]));
      } catch { run.rawCompletion = null; run.rawCompletionTextAvailable = false; run.captureError = 'completion-capture-failed-no-raw-output'; }
    } else run.rawOutputStatus = 'not-captured-for-non-success-response';
    save(); return response;
  };
  try {
    loadEnvFile('.env');
    const model = process.env[reviewer === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
    const apiKey = process.env[reviewer === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
    const baseUrl = process.env.ELICE_BASE_URL?.trim();
    if (model !== models[reviewer] || !apiKey || (reviewer === 'elice' && !baseUrl)) throw new Error('Provider settings do not match the experiment.');
    const provider = reviewer === 'gemini' ? createGeminiProvider({ apiKey, model }, observedFetch)
      : createEliceProvider({ apiKey, model, baseUrl }, observedFetch);
    server = createApp({ configured: provider.configured,
      async generateCandidates() { throw new Error('New candidate or draft generation is outside this experiment.'); },
      async generateExplanations(...values) {
        const run = activeRun;
        const parsed = await provider.generateExplanations(...values);
        run.adapterExplanations = structuredClone(parsed); return parsed;
      },
    }).listen(0, '127.0.0.1');
    await new Promise((ready, reject) => { server.once('listening', ready); server.once('error', reject); });
    report.state = 'running'; save();
    for (const entry of plan) {
      activeRun = { ...structuredClone(entry), state: 'pending', startedAt: new Date().toISOString() };
      report.runs.push(activeRun); save();
      const started = Date.now();
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/explanations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(50_000),
          body: JSON.stringify(entry.submittedInput),
        });
        activeRun.status = response.status; activeRun.response = await response.json();
      } catch { activeRun.transportError = 'local-request-failed'; }
      activeRun.elapsedMs = Date.now() - started;
      activeRun.state = 'finished'; activeRun.finishedAt = new Date().toISOString(); save();
      const errorCode = activeRun.response?.error?.code;
      console.log(JSON.stringify({ caseId: entry.caseId, originalProvider, reviewer, status: activeRun.status,
        error: errorCode ?? activeRun.transportError, modelCalls: report.modelCalls, elapsedMs: activeRun.elapsedMs }));
      if (activeRun.captureError || activeRun.transportError || hardFailures.includes(errorCode) || !activeRun.callId) {
        report.stopReason = activeRun.captureError ?? errorCode ?? activeRun.transportError ?? 'no-upstream-reservation'; break;
      }
    }
  } catch { report.runnerError = 'configuration-or-runner-failed'; process.exitCode = 1; }
  finally {
    report.finishedAt = new Date().toISOString();
    report.completed = !report.runnerError && !report.stopReason && report.runs.length === plan.length
      && report.runs.every(run => run.state === 'finished' && run.callId);
    report.state = report.completed ? 'completed' : 'stopped';
    try { save(); }
    finally { if (server) { server.closeAllConnections(); await new Promise(closed => server.close(closed)); } }
  }
  console.log(JSON.stringify({ reportPath, modelCalls: report.modelCalls, completed: report.completed, unexecuted: report.unexecuted.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runCrossReview();
