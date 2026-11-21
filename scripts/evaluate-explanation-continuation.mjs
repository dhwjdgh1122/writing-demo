// Explicit manual paired experiment. Dry-run does not read .env, write files, or call a model.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.ts';
import { createGeminiProvider } from '../server/llm/gemini.ts';
import { createEliceProvider } from '../server/llm/elice.ts';
import { explanationInputSchema } from '../shared/contracts.ts';
import { finishContinuationCall, inspectContinuationLedger, reserveContinuationCall } from './lib/model-call-continuation.mjs';

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const providers = ['gemini', 'elice'];
const modelNames = { gemini: 'gemini-3.5-flash-lite', elice: 'gpt-4o-mini' };
const hash = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && identifier.test(value);
const exportName = value => typeof value === 'string' && /^[a-zA-Z_$][\w$]*$/.test(value);
const hardFailures = ['MODEL_NOT_CONFIGURED', 'MODEL_CONFIGURATION_ERROR', 'MODEL_QUOTA_EXCEEDED',
  'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_REQUEST_FAILED'];

function repositoryPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A repository-local experiment path is required.');
  const path = resolve(value), pathFromRoot = relative(process.cwd(), path);
  if (pathFromRoot === '..' || pathFromRoot.startsWith('../') || pathFromRoot.startsWith('..\\') || isAbsolute(pathFromRoot)) {
    throw new Error('Experiment paths must remain inside the repository.');
  }
  return path;
}

export function buildContinuationPlan(config, fixture) {
  const allowed = ['experimentId', 'fixturePath', 'caseIds', 'arms', 'promptModule', 'reportPrefix', 'perProviderMaxCalls', 'ledgerPath'];
  if (!isObject(config) || Object.keys(config).some(key => !allowed.includes(key)) || !safeId(config.experimentId)
    || !Array.isArray(config.caseIds) || config.caseIds.length === 0 || !config.caseIds.every(safeId)
    || new Set(config.caseIds).size !== config.caseIds.length || !Array.isArray(config.arms) || config.arms.length !== 2
    || !config.arms.every(arm => isObject(arm)
      && ['id,instructionExport', 'id,instructionExport,referenceExport'].includes(Object.keys(arm).sort().join(','))
      && safeId(arm.id) && exportName(arm.instructionExport)
      && (!Object.hasOwn(arm, 'referenceExport') || exportName(arm.referenceExport)))
    || new Set(config.arms.map(arm => arm.id)).size !== config.arms.length
    || !Number.isSafeInteger(config.perProviderMaxCalls) || config.perProviderMaxCalls <= 0
    || !Array.isArray(fixture) || !fixture.every(c => isObject(c) && safeId(c.id))
    || new Set(fixture.map(c => c.id)).size !== fixture.length) throw new Error('Invalid continuation experiment plan or fixture.');
  for (const field of ['fixturePath', 'promptModule', 'reportPrefix', 'ledgerPath']) repositoryPath(config[field]);
  const cases = config.caseIds.map(id => {
    const c = fixture.find(item => item.id === id);
    if (!c) throw new Error('A planned case is missing from the fixture.');
    explanationInputSchema.parse({ requestId: c.id, sourceText: c.sourceText, candidates: c.candidates });
    return c;
  });
  const plan = cases.flatMap((c, index) => (index % 2 ? [...config.arms].reverse() : config.arms)
    .map(arm => ({ caseId: c.id, arm: arm.id })));
  if (plan.length > config.perProviderMaxCalls || plan.some(entry => `${entry.caseId}-${entry.arm}`.length > 120)) {
    throw new Error('Planned requests exceed the experiment cap or identifier limit.');
  }
  return { cases, plan };
}

// Whitelist the request payload. Fixture required/forbidden/origin fields remain report-only.
export function continuationInput(c, requestId) {
  return explanationInputSchema.parse({ requestId, sourceText: c.sourceText,
    candidates: c.candidates.map(candidate => ({ id: candidate.id, text: candidate.text })) });
}

// References come only from one fixed prompt-module export per arm, never from
// case metadata or a case-dependent function. This checks shape and boundaries,
// not the truth or official provenance of the definitions; those need review.
export function continuationReferences(value) {
  const boundedText = (text, limit) => typeof text === 'string' && text.trim().length > 0 && [...text].length <= limit;
  const sourceUrl = value => {
    if (!boundedText(value, 2048) || value !== value.trim() || /[\s\u0000-\u001f]/u.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
    } catch { return false; }
  };
  if (!Array.isArray(value) || value.length < 1 || value.length > 8
    || !value.every(entry => isObject(entry) && Object.keys(entry).sort().join(',') === 'definition,sourceUrl,term'
      && boundedText(entry.term, 80) && entry.term === entry.term.trim()
      && boundedText(entry.definition, 1000) && sourceUrl(entry.sourceUrl))
    || new Set(value.map(entry => entry.term)).size !== value.length) {
    throw new Error('Invalid fixed lexical references: expected bounded term/definition/HTTPS sourceUrl records only.');
  }
  return value.map(({ term, definition, sourceUrl }) => ({ term, definition, sourceUrl }));
}

// Verify the product provider's untouched payload before adding the experiment's
// fixed data. A new field must never become a loophole for fixture answers.
export function continuationModelInput(input, submittedInput, lexicalReferences) {
  const submitted = explanationInputSchema.parse(submittedInput);
  const expected = { sourceText: submitted.sourceText, candidates: submitted.candidates };
  if (!isObject(input) || Object.keys(input).sort().join(',') !== 'candidates,sourceText'
    || JSON.stringify(input) !== JSON.stringify(expected)) {
    throw new Error('Unexpected model input; experiment metadata or answers must never be sent.');
  }
  return lexicalReferences === undefined ? structuredClone(expected)
    : { ...structuredClone(expected), lexicalReferences: continuationReferences(lexicalReferences) };
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

export async function runContinuation(args = process.argv.slice(2)) {
  const usage = 'Usage: node --import tsx scripts/evaluate-explanation-continuation.mjs --plan=PATH --provider=gemini|elice [--live]';
  if (args.some(arg => arg !== '--live' && !arg.startsWith('--plan=') && !arg.startsWith('--provider='))
    || args.filter(arg => arg.startsWith('--plan=')).length !== 1
    || args.filter(arg => arg.startsWith('--provider=')).length !== 1 || new Set(args).size !== args.length) throw new Error(usage);
  const providerName = args.find(arg => arg.startsWith('--provider=')).slice('--provider='.length);
  if (!providers.includes(providerName)) throw new Error(usage);
  const planPath = repositoryPath(args.find(arg => arg.startsWith('--plan=')).slice('--plan='.length));
  const config = JSON.parse(readFileSync(planPath, 'utf8'));
  const fixturePath = repositoryPath(config.fixturePath);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const { cases, plan } = buildContinuationPlan(config, fixture);
  const promptPath = repositoryPath(config.promptModule);
  const promptModule = await import(pathToFileURL(promptPath).href);
  const instructions = Object.fromEntries(config.arms.map(arm => {
    const instruction = promptModule[arm.instructionExport];
    if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('A planned prompt export is missing.');
    return [arm.id, instruction];
  }));
  const promptSha256 = Object.fromEntries(Object.entries(instructions).map(([id, text]) => [id, hash(text)]));
  // Snapshot once for the whole plan: no case-specific reference lookup/filtering.
  const lexicalReferences = Object.fromEntries(config.arms.map(arm => [arm.id,
    arm.referenceExport === undefined ? null : continuationReferences(promptModule[arm.referenceExport])]));
  const referenceSha256 = Object.fromEntries(Object.entries(lexicalReferences).map(([id, value]) =>
    [id, value === null ? null : hash(JSON.stringify(value))]));
  const model = modelNames[providerName];
  const reportPath = repositoryPath(`${config.reportPrefix}-${providerName}.json`);
  const ledgerPath = repositoryPath(config.ledgerPath);
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ dryRun: true, experimentId: config.experimentId, provider: providerName, model,
      plan, plannedCalls: plan.length, perProviderMaxCalls: config.perProviderMaxCalls, reportPath,
      fixtureSha256: hash(readFileSync(fixturePath)), planSha256: hash(readFileSync(planPath)), promptSha256,
      lexicalReferences, referenceSha256,
      notes: 'No .env access, report writes or model calls. Required/forbidden fields are excluded from model input.' }));
    return;
  }

  const ledger = inspectContinuationLedger(ledgerPath);
  if (ledger.calls.some(call => call.experimentId === config.experimentId && call.provider === providerName)) {
    throw new Error('This experiment/provider has previous attempts. Preserve the report and review a new experiment instead of replaying it.');
  }
  const files = [planPath, fixturePath, promptPath, ledgerPath, ledger.previousLedger.path,
    'scripts/evaluate-explanation-continuation.mjs', 'scripts/lib/model-call-continuation.mjs',
    'server/llm/prompt.ts', 'server/llm/provider.ts', 'server/llm/gemini.ts', 'server/llm/elice.ts',
    'server/llm/parse-explanations.ts', 'server/llm/explanation-spacing.ts', 'server/llm/explanation-check.ts', 'server/app.ts', 'shared/contracts.ts', 'package-lock.json'];
  const report = {
    experimentId: config.experimentId, startedAt: new Date().toISOString(),
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    implementationSha256: Object.fromEntries([...new Set(files.map(path => repositoryPath(path)))].map(path =>
      [relative(process.cwd(), path).replaceAll('\\', '/'), hash(readFileSync(path))])),
    provider: providerName, model, config, cases, plan, instructions, promptSha256, lexicalReferences, referenceSha256,
    priorAuthorization: { previousLedger: ledger.previousLedger, authorization: ledger.authorization, callsAtStart: ledger.calls.length },
    path: 'Fixed candidates -> loopback /api/explanations -> selected real provider -> current parser (including spacing-only factual notice) and quotation check. Raw model output is evaluated separately. No correction generation or browser.',
    notes: 'Paired arms alternate order by case. No retries, model switching, answer-field injection or discarded failures. Raw completion, parsed model JSON, adapter and API outputs are distinct. This is not a user-benefit evaluation.',
    modelCallCounting: 'Durable reservation immediately before upstream fetch; interrupted/failed attempts count even when delivery or billing is unknown.',
    modelCalls: 0, state: 'preflight', completed: false, runs: [], unexecuted: [...plan],
  };
  // Exclusive creation prevents accidental overwrite by another process or a repeated command.
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const save = () => {
    report.unexecuted = plan.filter(entry => !report.runs.some(run => run.caseId === entry.caseId && run.arm === entry.arm && run.callId));
    saveReport(reportPath, report);
  };
  let activeRun = null, server = null;
  const observedFetch = async (url, options) => {
    const run = activeRun;
    if (!run || run.callId || report.modelCalls >= config.perProviderMaxCalls || report.modelCalls >= plan.length) {
      throw new Error('Unexpected additional model request.');
    }
    const body = JSON.parse(options.body);
    const input = JSON.parse(providerName === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content);
    const sentInput = continuationModelInput(input, run.submittedInput, lexicalReferences[run.arm] ?? undefined);
    const instruction = instructions[run.arm];
    if (providerName === 'gemini') {
      body.systemInstruction = { parts: [{ text: instruction }] };
      body.contents[0].parts[0].text = JSON.stringify(sentInput);
    } else {
      body.messages[0].content = instruction;
      body.messages[1].content = JSON.stringify(sentInput);
    }
    run.sentInput = structuredClone(sentInput);
    run.instructionSha256 = hash(instruction);
    run.referenceSha256 = referenceSha256[run.arm];
    run.requestSettings = providerName === 'gemini' ? body.generationConfig
      : { model: body.model, response_format: body.response_format, n: body.n, stream: body.stream, max_tokens: body.max_tokens };
    options.signal?.throwIfAborted();
    run.callId = reserveContinuationCall(ledgerPath, { experimentId: config.experimentId,
      label: `${run.caseId}-${run.arm}`, provider: providerName, model }, config.perProviderMaxCalls);
    report.modelCalls++;
    run.callState = 'reserved-result-unknown';
    save();
    let response;
    try { response = await fetch(url, { ...options, body: JSON.stringify(body) }); }
    catch (error) {
      finishContinuationCall(ledgerPath, run.callId, { status: 'failed' });
      run.callState = 'fetch-failed'; save(); throw error;
    }
    finishContinuationCall(ledgerPath, run.callId, { status: 'received', httpStatus: response.status });
    run.callState = 'response-received'; run.upstreamStatus = response.status;
    if (response.ok) {
      try {
        const envelope = await response.clone().json();
        const respondedModel = providerName === 'gemini' ? envelope.modelVersion : envelope.model;
        if (typeof respondedModel === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(respondedModel)
          && !/^(?:sk-|AIza)/.test(respondedModel)) run.respondedModel = respondedModel;
        run.rawCompletion = providerName === 'gemini'
          ? { finishReason: envelope.candidates?.[0]?.finishReason,
            text: envelope.candidates?.[0]?.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('') ?? null }
          : { finishReason: envelope.choices?.[0]?.finish_reason, text: envelope.choices?.[0]?.message?.content ?? null };
        run.rawCompletionTextAvailable = typeof run.rawCompletion.text === 'string';
        if (run.rawCompletionTextAvailable) {
          try { run.parsedModelOutput = JSON.parse(run.rawCompletion.text); }
          catch { run.rawParseError = 'completion-is-not-valid-json'; }
        } else run.rawParseError = 'no-completion-text';
        const usage = providerName === 'gemini' ? envelope.usageMetadata : envelope.usage;
        const keys = providerName === 'gemini' ? ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
          : ['prompt_tokens', 'completion_tokens', 'total_tokens'];
        run.tokenUsage = Object.fromEntries(keys.filter(key => typeof usage?.[key] === 'number').map(key => [key, usage[key]]));
      } catch {
        run.rawCompletion = null; run.rawCompletionTextAvailable = false;
        run.captureError = 'completion-capture-failed-no-raw-output';
      }
    } else run.rawOutputStatus = 'not-captured-for-non-success-response';
    save();
    return response;
  };
  try {
    loadEnvFile('.env');
    const configuredModel = process.env[providerName === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
    const apiKey = process.env[providerName === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
    const baseUrl = process.env.ELICE_BASE_URL?.trim();
    if (configuredModel !== model || !apiKey || (providerName === 'elice' && !baseUrl)) throw new Error('Provider settings do not match the experiment.');
    const provider = providerName === 'gemini' ? createGeminiProvider({ apiKey, model }, observedFetch)
      : createEliceProvider({ apiKey, model, baseUrl }, observedFetch);
    const observedProvider = {
      configured: provider.configured,
      async generateCandidates() { throw new Error('Candidate generation is outside this experiment.'); },
      async generateExplanations(...values) {
        const run = activeRun;
        const parsed = await provider.generateExplanations(...values);
        run.adapterExplanations = structuredClone(parsed);
        return parsed;
      },
    };
    server = createApp(observedProvider).listen(0, '127.0.0.1');
    await new Promise((resolveReady, reject) => { server.once('listening', resolveReady); server.once('error', reject); });
    report.state = 'running'; save();
    for (const [index, entry] of plan.entries()) {
      const c = cases.find(item => item.id === entry.caseId);
      const submittedInput = continuationInput(c, `continuation-${index}-${entry.arm}`);
      activeRun = { ...entry, submittedInput, startedAt: new Date().toISOString(), state: 'pending' };
      report.runs.push(activeRun); save();
      const started = Date.now();
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/explanations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(50_000),
          body: JSON.stringify(submittedInput),
        });
        activeRun.status = response.status;
        activeRun.response = await response.json();
      } catch { activeRun.transportError = 'local-request-failed'; }
      activeRun.elapsedMs = Date.now() - started;
      activeRun.state = 'finished'; activeRun.finishedAt = new Date().toISOString(); save();
      const errorCode = activeRun.response?.error?.code;
      console.log(JSON.stringify({ caseId: entry.caseId, arm: entry.arm, status: activeRun.status,
        error: errorCode ?? activeRun.transportError,
        withheld: activeRun.response?.explanations?.filter(item => 'error' in item).map(item => item.candidateId),
        modelCalls: report.modelCalls, elapsedMs: activeRun.elapsedMs }));
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
    finally {
      if (server) { server.closeAllConnections(); await new Promise(resolveClosed => server.close(resolveClosed)); }
    }
  }
  console.log(JSON.stringify({ reportPath, modelCalls: report.modelCalls, completed: report.completed, unexecuted: report.unexecuted.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runContinuation();
