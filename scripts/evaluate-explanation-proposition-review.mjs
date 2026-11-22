// Manual bounded diagnostic; default dry-run has no .env, writes or model calls.
// Reuses the frozen cases, provider payload settings, ledger and offline contract.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPropositionPlan, buildPropositionRequest } from './evaluate-explanation-propositions.mjs';
import { propositionInput } from './lib/explanation-propositions.mjs';
import { createPropositionReviewSnapshot, REVIEW_CONTRACT_VERSION } from './lib/explanation-proposition-review.mjs';
import { reviewInstruction, reviewResponseSchema } from './lib/explanation-proposition-review-prompt.mjs';
import { inspectContinuationLedger, reserveContinuationCall, finishContinuationCall } from './lib/model-call-continuation.mjs';

const experimentId = 'issue22-proposition-review-20261122';
const fixturePath = 'tests/fixtures/explanation-propositions-2026-11-22.json';
const ledgerPath = 'docs/evaluations/approved-model-calls-continuation-2026-11-22.json';
const planPath = 'docs/evaluations/explanation-proposition-review-plan-2026-11-22.md';
const models = { elice: 'gpt-4o-mini', gemini: 'gemini-3.5-flash-lite' };
const perProviderMaxCalls = 3;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const canonicalHash = value => hash(JSON.stringify(canonical(value)));

export function buildReviewPlan(fixture) {
  return buildPropositionPlan(fixture).map(entry => ({ ...entry, label: `${entry.caseId}-proposition-review` }));
}

export function buildReviewRequest(provider, value) {
  const body = buildPropositionRequest(provider, value);
  if (provider === 'gemini') {
    body.systemInstruction.parts[0].text = reviewInstruction;
    body.generationConfig.responseJsonSchema = reviewResponseSchema();
  } else body.messages[0].content = reviewInstruction;
  return body;
}

export function captureReviewCompletion(provider, envelope, inputValue, metadata) {
  const input = propositionInput(inputValue);
  if (!Object.hasOwn(models, provider)) throw new Error('Unsupported diagnostic provider.');
  const result = { semanticAssessment: 'not-performed' };
  const respondedModel = provider === 'gemini' ? envelope?.modelVersion : envelope?.model;
  if (typeof respondedModel === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(respondedModel)
    && !/^(?:sk-|AIza)/.test(respondedModel)) result.respondedModel = respondedModel;
  const usage = provider === 'gemini' ? envelope?.usageMetadata : envelope?.usage;
  const keys = provider === 'gemini' ? ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
    : ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  result.tokenUsage = Object.fromEntries(keys.filter(key => Number.isFinite(usage?.[key]) && usage[key] >= 0).map(key => [key, usage[key]]));
  const choices = provider === 'gemini' ? envelope?.candidates : envelope?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : undefined;
  const parts = choice?.content?.parts;
  const text = provider === 'gemini'
    ? (Array.isArray(parts) ? parts.filter(part => !part?.thought && typeof part?.text === 'string').map(part => part.text).join('') : null)
    : (typeof choice?.message?.content === 'string' ? choice.message.content : null);
  const finishReason = provider === 'gemini' ? choice?.finishReason : choice?.finish_reason;
  result.rawCompletion = { finishReason: typeof finishReason === 'string' ? finishReason : null, text };
  result.rawCompletionTextAvailable = typeof text === 'string' && text.trim().length > 0;
  if (!result.rawCompletionTextAvailable) { result.captureError = 'completion-text-unavailable'; return result; }
  result.rawCompletionSha256 = hash(text);
  try { result.parsedModelOutput = JSON.parse(text); } catch { /* snapshot reports strict parse failure */ }
  const blocked = provider === 'gemini' ? Boolean(envelope?.promptFeedback?.blockReason) : Boolean(choice?.message?.refusal);
  if (blocked || finishReason !== (provider === 'gemini' ? 'STOP' : 'stop')) {
    result.validationError = 'blocked-or-incomplete-completion'; return result;
  }
  result.reviewValidation = createPropositionReviewSnapshot(input, text, metadata);
  if (!result.reviewValidation.ok) result.validationError = result.reviewValidation.validationError;
  return result;
}

/** Injected transport/storage makes failure handling testable without credentials.
 * Production passes the existing locked ledger. Reservations count before I/O. */
export async function executeReviewPlan({ provider, plan, runId, reserve, call, finish, save, log = () => {}, report = {} }) {
  const expectedPlan = buildReviewPlan(JSON.parse(readFileSync(fixturePath, 'utf8')));
  if (!Object.hasOwn(models, provider) || canonicalHash(plan) !== canonicalHash(expectedPlan)
    || typeof runId !== 'string' || !runId.trim() || [...runId].length > 128) throw new Error('Frozen review plan or run identity mismatch.');
  const result = { ...structuredClone(report), runId, provider, model: models[provider], plan: structuredClone(plan),
    modelCalls: 0, state: 'running', completed: false, runs: [], unexecuted: plan.map(entry => entry.label) };
  const persist = () => {
    result.unexecuted = plan.filter(entry => !result.runs.some(run => run.label === entry.label)).map(entry => entry.label);
    result.structuralSummary = result.runs.map(run => ({ caseId: run.caseId,
      status: run.reviewValidation?.ok ? 'structure-valid-only' : run.validationError ? 'format-failure' : 'not-assessed' }));
    save(structuredClone(result));
  };
  persist();
  try {
    for (const entry of plan) {
      const body = buildReviewRequest(provider, entry.input);
      const run = { caseId: entry.caseId, label: entry.label, sentInput: propositionInput(entry.input),
        sentInputSha256: canonicalHash(entry.input), requestBodySha256: canonicalHash(body),
        startedAt: new Date().toISOString(), semanticAssessment: 'not-performed', state: 'pending' };
      run.callId = reserve(entry); result.modelCalls++;
      run.callState = 'reserved-result-unknown'; result.runs.push(run); persist();
      const started = Date.now();
      let response;
      try { response = await call(entry, body, run.callId); }
      catch { response = { transportError: 'request-failed' }; }
      if (response?.transportError || !Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
        run.callState = 'fetch-failed';
        run.transportError = response?.transportError === 'timeout' ? 'timeout' : 'request-failed';
        result.stopReason = run.transportError;
      } else {
        run.callState = 'response-received'; run.upstreamStatus = response.status;
        if (response.status < 200 || response.status >= 300) {
          run.serviceError = [400, 401, 403, 404, 422].includes(response.status) ? 'configuration'
            : [402, 429].includes(response.status) ? 'quota' : 'unavailable';
          run.rawOutputStatus = 'not-captured-for-non-success-response'; result.stopReason = run.serviceError;
        } else {
          if (response.captureError) { run.captureError = 'response-json-unavailable'; run.rawCompletionTextAvailable = false; }
          else Object.assign(run, captureReviewCompletion(provider, response.envelope, run.sentInput, { runId, requestId: run.callId }));
          if (run.captureError) result.stopReason = run.captureError;
        }
      }
      // Preserve an acquired response even when the ledger lock/write fails.
      // The ledger can remain reserved; that uncertainty must not erase output.
      run.ledgerState = 'reserved'; persist();
      try {
        finish(run.callId, run.upstreamStatus === undefined ? { status: 'failed' }
          : { status: 'received', httpStatus: run.upstreamStatus });
        run.ledgerState = 'outcome-recorded';
      } catch { run.ledgerError = 'outcome-record-failed'; result.stopReason = 'ledger-outcome-failed'; }
      run.elapsedMs = Date.now() - started; run.finishedAt = new Date().toISOString(); run.state = 'finished'; persist();
      log({ label: run.label, modelCalls: result.modelCalls, upstreamStatus: run.upstreamStatus,
        validationError: run.validationError, stopReason: result.stopReason });
      if (result.stopReason) break;
    }
  } catch { result.runnerError = 'runner-or-storage-failed'; }
  finally {
    result.finishedAt = new Date().toISOString();
    result.completed = !result.runnerError && !result.stopReason && result.runs.length === plan.length
      && result.runs.every(run => run.state === 'finished');
    result.state = result.completed ? 'completed' : 'stopped'; persist();
  }
  return result;
}

function configuration(provider) {
  const model = process.env[provider === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
  const apiKey = process.env[provider === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
  if (model !== models[provider] || !apiKey) throw new Error('Provider configuration mismatch.');
  if (provider === 'gemini') return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
  };
  const url = new URL(process.env.ELICE_BASE_URL?.trim());
  if (url.protocol !== 'https:' || url.hostname !== 'mlapi.run' || url.port || url.username || url.password || url.search || url.hash
    || !/^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\/v1)?\/?$/i.test(url.pathname)) throw new Error('Provider configuration mismatch.');
  return { url: `${url.origin}${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } };
}

function saveReport(path, report) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600); created = true;
    writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n', 'utf8'); fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined; renameSync(temporary, path); created = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) unlinkSync(temporary);
  }
}

export async function runPropositionReview(args = process.argv.slice(2)) {
  if (args.some(arg => !['--provider=elice', '--provider=gemini', '--live', '--confirm-authorized'].includes(arg))
    || args.filter(arg => arg.startsWith('--provider=')).length !== 1 || new Set(args).size !== args.length
    || args.includes('--live') !== args.includes('--confirm-authorized')) throw new Error('Use --provider=elice|gemini [--live --confirm-authorized]. Default is dry-run.');
  const provider = args.find(arg => arg.startsWith('--provider=')).slice('--provider='.length);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')), plan = buildReviewPlan(fixture);
  const reportPath = `docs/evaluations/explanation-proposition-review-2026-11-22-${provider}.json`;
  const preview = { dryRun: true, experimentId, contractVersion: REVIEW_CONTRACT_VERSION, provider, model: models[provider],
    plan: plan.map(({ caseId, label }) => ({ caseId, label, textIds: ['t1', 't2'] })),
    perProviderMaxCalls, totalPlannedAcrossProviders: 6, frozenFixtureSha256: canonicalHash(fixture),
    instructionSha256: hash(reviewInstruction), responseSchemaSha256: canonicalHash(reviewResponseSchema()), reportPath,
    notes: 'No .env access, writes or model calls. Structure/provenance only; semantic review is separate.' };
  if (!args.includes('--live')) { console.log(JSON.stringify(preview)); return preview; }
  const ledger = inspectContinuationLedger(ledgerPath);
  if (ledger.calls.some(entry => entry.experimentId === experimentId && entry.provider === provider)) throw new Error('Previous attempt exists; do not replay.');
  const files = [fixturePath, planPath, ledgerPath, ledger.previousLedger.path, 'scripts/evaluate-explanation-proposition-review.mjs',
    'scripts/evaluate-explanation-propositions.mjs', 'scripts/lib/explanation-propositions.mjs',
    'scripts/lib/explanation-proposition-review.mjs', 'scripts/lib/explanation-proposition-review-prompt.mjs',
    'scripts/lib/model-call-continuation.mjs', 'package.json', 'package-lock.json'];
  const report = { ...preview, dryRun: false, runId: randomUUID(), startedAt: new Date().toISOString(),
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    implementationSha256: Object.fromEntries(files.map(path => [path, hash(readFileSync(path))])),
    instruction: reviewInstruction, responseSchema: reviewResponseSchema(), fixturePath, cases: fixture.cases,
    evaluationPlan: readFileSync(planPath, 'utf8'), reportOnlyRoles: { t1: 'original source', t2: 'candidate' },
    priorLedger: { previousLedger: ledger.previousLedger, callsAtStart: ledger.calls.length },
    scope: 'Six-request diagnostic only. Old open-ended authorization is not resumed. No product or judge calls.',
    modelCalls: 0, state: 'preflight', completed: false, runs: [], unexecuted: plan.map(entry => entry.label) };
  // Exclusive creation prevents overwriting any earlier raw report, including preflight failures.
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  let result;
  try {
    loadEnvFile('.env'); const config = configuration(provider);
    const body = buildReviewRequest(provider, plan[0].input);
    report.requestSettings = provider === 'gemini' ? body.generationConfig
      : Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'messages'));
    result = await executeReviewPlan({ provider, plan, runId: report.runId, report,
      reserve: entry => reserveContinuationCall(ledgerPath, { experimentId, label: entry.label, provider, model: models[provider] }, perProviderMaxCalls),
      finish: (id, outcome) => finishContinuationCall(ledgerPath, id, outcome),
      save: value => saveReport(reportPath, value), log: value => console.log(JSON.stringify(value)),
      call: async (_entry, requestBody) => {
        const signal = AbortSignal.timeout(45_000);
        let response;
        try { response = await fetch(config.url, { method: 'POST', redirect: 'error', headers: config.headers, signal, body: JSON.stringify(requestBody) }); }
        catch { return { transportError: signal.aborted ? 'timeout' : 'request-failed' }; }
        if (!response.ok) { try { await response.body?.cancel(); } catch { /* do not capture error bodies */ } return { status: response.status }; }
        try { return { status: response.status, envelope: await response.json() }; }
        catch { return { status: response.status, captureError: 'response-json-unavailable' }; }
      },
    });
  } catch {
    // A storage failure after reservation must not erase the last persisted run.
    result = JSON.parse(readFileSync(reportPath, 'utf8'));
    result.runnerError = 'configuration-or-runner-failed'; result.state = 'stopped'; result.completed = false;
    result.finishedAt = new Date().toISOString(); saveReport(reportPath, result);
  }
  if (result.runnerError) process.exitCode = 1;
  console.log(JSON.stringify({ reportPath, modelCalls: result.modelCalls, completed: result.completed, unexecuted: result.unexecuted.length }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPropositionReview();
