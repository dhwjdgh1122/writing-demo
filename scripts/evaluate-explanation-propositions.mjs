// Manual proposition-generation diagnosis only. No NLI judge or product change.
// Reuses the isolated-conditions runner's provider, ledger and report approach.
// Default dry-run never reads .env, writes a report/ledger or calls a model.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectContinuationLedger, reserveContinuationCall, finishContinuationCall } from './lib/model-call-continuation.mjs';
import { propositionInput, propositionInstruction, propositionResponseSchema, validatePropositionResult } from './lib/explanation-propositions.mjs';

const experimentId = 'issue22-propositions-20261122';
const fixturePath = 'tests/fixtures/explanation-propositions-2026-11-22.json';
const ledgerPath = 'docs/evaluations/approved-model-calls-continuation-2026-11-22.json';
const frozenFixtureSha256 = '35bad461e5fef6686e8f342e7a8501b6d0cd73f59bc50112552b40ff1306c5dd';
const caseIds = ['CT-03', 'EQ-03', 'E-03'];
const models = { elice: 'gpt-4o-mini', gemini: 'gemini-3.5-flash-lite' };
const perProviderMaxCalls = 3;
const hash = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const canonicalHash = value => hash(JSON.stringify(canonical(value)));

export function buildPropositionPlan(fixture) {
  if (canonicalHash(fixture) !== frozenFixtureSha256) throw new Error('Frozen proposition fixture content changed.');
  return caseIds.map(caseId => {
    const matches = fixture.cases.filter(item => item.id === caseId);
    if (matches.length !== 1 || matches[0].candidates.length !== 1) throw new Error('Frozen case identity or candidate count changed.');
    const entry = matches[0];
    return { caseId, label: `${caseId}-propositions`, input: propositionInput({ texts: [
      { id: 't1', text: entry.sourceText }, { id: 't2', text: entry.candidates[0].text },
    ] }) };
  });
}

export function buildPropositionRequest(provider, value) {
  const input = propositionInput(value);
  if (provider === 'gemini') return {
    systemInstruction: { parts: [{ text: propositionInstruction }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: { candidateCount: 1, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'LOW' },
      responseMimeType: 'application/json', responseJsonSchema: propositionResponseSchema() },
  };
  if (provider === 'elice') return {
    model: models.elice, response_format: { type: 'json_object' }, n: 1, stream: false, max_tokens: 2000,
    messages: [{ role: 'system', content: propositionInstruction }, { role: 'user', content: JSON.stringify(input) }],
  };
  throw new Error('Unsupported diagnostic provider.');
}

function requestConfiguration(provider, apiKey, model, baseUrl) {
  if (model !== models[provider] || typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Provider configuration mismatch.');
  if (provider === 'gemini') return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
  };
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Provider configuration mismatch.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'mlapi.run' || url.port || url.username || url.password
    || url.search || url.hash || !/^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\/v1)?\/?$/i.test(url.pathname)) {
    throw new Error('Provider configuration mismatch.');
  }
  return { url: `${url.origin}${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } };
}

/** Keep the original completion before parsing or checking provenance. No
 * envelope/error body, headers or arbitrary provider fields enter this result. */
export function capturePropositionCompletion(provider, envelope, inputValue) {
  const input = propositionInput(inputValue);
  if (!Object.hasOwn(models, provider)) throw new Error('Unsupported diagnostic provider.');
  const result = { semanticAssessment: 'not-performed' };
  const respondedModel = provider === 'gemini' ? envelope?.modelVersion : envelope?.model;
  if (typeof respondedModel === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(respondedModel)
    && !/^(?:sk-|AIza)/.test(respondedModel)) result.respondedModel = respondedModel;
  const usage = provider === 'gemini' ? envelope?.usageMetadata : envelope?.usage;
  const keys = provider === 'gemini' ? ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
    : ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  result.tokenUsage = Object.fromEntries(keys.filter(key => Number.isFinite(usage?.[key])).map(key => [key, usage[key]]));
  const choices = provider === 'gemini' ? envelope?.candidates : envelope?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : undefined;
  const parts = choice?.content?.parts;
  result.rawCompletion = provider === 'gemini'
    ? { finishReason: choice?.finishReason, text: Array.isArray(parts)
      ? parts.filter(part => !part?.thought && typeof part?.text === 'string').map(part => part.text).join('') : null }
    : { finishReason: choice?.finish_reason, text: choice?.message?.content ?? null };
  const text = result.rawCompletion.text;
  result.rawCompletionTextAvailable = typeof text === 'string' && text.trim().length > 0;
  if (!result.rawCompletionTextAvailable) {
    result.captureError = 'completion-text-unavailable'; return result;
  }
  try { result.parsedModelOutput = JSON.parse(text); }
  catch { result.validationError = 'completion-json'; }
  const blocked = provider === 'gemini' ? Boolean(envelope?.promptFeedback?.blockReason) : Boolean(choice?.message?.refusal);
  if (blocked || result.rawCompletion.finishReason !== (provider === 'gemini' ? 'STOP' : 'stop')) {
    result.validationError = 'blocked-or-incomplete-completion'; return result;
  }
  if (!result.validationError) {
    try {
      result.propositionValidation = validatePropositionResult(input, result.parsedModelOutput);
      if (!result.propositionValidation.ok) result.validationError = result.propositionValidation.validationError;
    } catch { result.diagnosisError = 'proposition-validation-failed'; }
  }
  return result;
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

export async function runPropositions(args = process.argv.slice(2)) {
  if (args.some(arg => !['--provider=elice', '--provider=gemini', '--live', '--confirm-authorized'].includes(arg))
    || args.filter(arg => arg.startsWith('--provider=')).length !== 1 || new Set(args).size !== args.length
    || args.includes('--live') !== args.includes('--confirm-authorized')) {
    throw new Error('Use --provider=elice|gemini [--live --confirm-authorized]. Default is dry-run.');
  }
  const provider = args.find(arg => arg.startsWith('--provider=')).slice('--provider='.length);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const plan = buildPropositionPlan(fixture);
  const reportPath = `docs/evaluations/explanation-propositions-2026-11-22-${provider}.json`;
  const instructionSha256 = hash(propositionInstruction);
  const responseSchema = propositionResponseSchema();
  if (!args.includes('--live')) {
    const preview = { dryRun: true, experimentId, provider, model: models[provider],
      plan: plan.map(entry => ({ caseId: entry.caseId, label: entry.label, textIds: entry.input.texts.map(text => text.id) })),
      perProviderMaxCalls, totalPlannedAcrossProviders: 6, frozenFixtureSha256, instructionSha256,
      responseSchemaSha256: canonicalHash(responseSchema), reportPath,
      notes: 'No .env access, writes or model calls. Texts only; no answers, NLI judgement or generated explanation.' };
    console.log(JSON.stringify(preview)); return preview;
  }
  const ledger = inspectContinuationLedger(ledgerPath);
  if (ledger.calls.some(call => call.experimentId === experimentId && call.provider === provider)) {
    throw new Error('This experiment/provider has previous attempts; do not replay them.');
  }
  const files = [fixturePath, ledgerPath, ledger.previousLedger.path, 'scripts/evaluate-explanation-propositions.mjs',
    'scripts/lib/explanation-propositions.mjs', 'scripts/lib/model-call-continuation.mjs',
    'tests/explanation-propositions.test.ts', 'tests/explanation-propositions-runner.test.ts',
    'server/llm/gemini.ts', 'server/llm/elice.ts', 'package.json', 'package-lock.json'];
  const report = {
    experimentId, startedAt: new Date().toISOString(), provider, model: models[provider],
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    implementationSha256: Object.fromEntries(files.map(path => [path, hash(readFileSync(path))])),
    fixturePath, frozenFixtureSha256, caseSha256: Object.fromEntries(fixture.cases.map(item => [item.id, canonicalHash(item)])),
    instruction: propositionInstruction, instructionSha256, responseSchema, responseSchemaSha256: canonicalHash(responseSchema),
    cases: fixture.cases, plan, perProviderMaxCalls, reportOnlyRoles: { t1: 'original source', t2: 'candidate' },
    priorAuthorization: { previousLedger: ledger.previousLedger, authorization: ledger.authorization, callsAtStart: ledger.calls.length },
    path: 'Direct provider proposition generation; no application API, explanation generation or NLI judge.',
    limits: 'Exact quotation and valid shape are not semantic accuracy, complete coverage or entailment. At most eight generated propositions; missing distinctions remain possible. Criteria and source roles are report-only.',
    modelCalls: 0, state: 'preflight', completed: false, runs: [], unexecuted: plan.map(entry => entry.label),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const save = () => {
    report.unexecuted = plan.filter(entry => !report.runs.some(run => run.label === entry.label && run.callId)).map(entry => entry.label);
    report.structuralSummary = report.runs.map(run => ({ caseId: run.caseId,
      propositionCount: run.propositionValidation?.ok ? run.propositionValidation.propositions.length : null,
      status: run.propositionValidation?.ok ? 'structure-valid-only' : run.validationError ? 'format-failure' : 'not-assessed',
    }));
    saveReport(reportPath, report);
  };
  try {
    loadEnvFile('.env');
    const model = process.env[provider === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
    const apiKey = process.env[provider === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
    const configuration = requestConfiguration(provider, apiKey, model, process.env.ELICE_BASE_URL?.trim());
    const firstBody = buildPropositionRequest(provider, plan[0].input);
    report.requestSettings = provider === 'gemini' ? structuredClone(firstBody.generationConfig)
      : Object.fromEntries(Object.entries(firstBody).filter(([key]) => key !== 'messages'));
    report.state = 'running'; save();
    for (const entry of plan) {
      const sentInput = propositionInput(entry.input);
      const body = buildPropositionRequest(provider, sentInput);
      const run = { caseId: entry.caseId, label: entry.label, sentInput, sentInputSha256: canonicalHash(sentInput),
        startedAt: new Date().toISOString(), semanticAssessment: 'not-performed', state: 'pending' };
      const signal = AbortSignal.timeout(45_000);
      signal.throwIfAborted();
      run.callId = reserveContinuationCall(ledgerPath, { experimentId, label: entry.label, provider, model }, perProviderMaxCalls);
      report.modelCalls++; run.callState = 'reserved-result-unknown'; report.runs.push(run); save();
      const started = Date.now();
      let response;
      try { response = await fetch(configuration.url, { method: 'POST', redirect: 'error', headers: configuration.headers, signal, body: JSON.stringify(body) }); }
      catch {
        finishContinuationCall(ledgerPath, run.callId, { status: 'failed' });
        run.callState = 'fetch-failed'; run.transportError = signal.aborted ? 'timeout' : 'request-failed'; report.stopReason = run.transportError;
      }
      if (response) {
        finishContinuationCall(ledgerPath, run.callId, { status: 'received', httpStatus: response.status });
        run.callState = 'response-received'; run.upstreamStatus = response.status;
        if (!response.ok) {
          run.rawOutputStatus = 'not-captured-for-non-success-response';
          run.serviceError = [400, 401, 403, 404, 422].includes(response.status) ? 'configuration'
            : [402, 429].includes(response.status) ? 'quota' : 'unavailable';
          report.stopReason = run.serviceError;
          try { await response.body?.cancel(); } catch { /* never read an error body */ }
        } else {
          let envelope;
          try { envelope = await response.json(); }
          catch { run.captureError = 'response-json-unavailable'; run.rawCompletionTextAvailable = false; }
          if (!run.captureError) {
            try { Object.assign(run, capturePropositionCompletion(provider, envelope, sentInput)); }
            catch { run.captureError = 'completion-capture-failed'; run.rawCompletionTextAvailable = false; }
          }
          if (run.captureError || run.diagnosisError) report.stopReason = run.captureError ?? run.diagnosisError;
        }
      }
      run.elapsedMs = Date.now() - started; run.finishedAt = new Date().toISOString(); run.state = 'finished'; save();
      console.log(JSON.stringify({ label: run.label, upstreamStatus: run.upstreamStatus, modelCalls: report.modelCalls,
        validationError: run.validationError, stopReason: report.stopReason, elapsedMs: run.elapsedMs }));
      if (report.stopReason) break;
    }
  } catch { report.runnerError = 'configuration-or-runner-failed'; process.exitCode = 1; }
  finally {
    report.finishedAt = new Date().toISOString();
    report.completed = !report.runnerError && !report.stopReason && report.runs.length === plan.length
      && report.runs.every(run => run.state === 'finished' && run.callId);
    report.state = report.completed ? 'completed' : 'stopped'; save();
  }
  console.log(JSON.stringify({ reportPath, modelCalls: report.modelCalls, completed: report.completed, unexecuted: report.unexecuted.length }));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPropositions();
