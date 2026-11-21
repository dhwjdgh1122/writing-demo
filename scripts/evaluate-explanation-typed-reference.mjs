// Manual direct-provider diagnosis. Default dry-run never reads .env, writes, or
// calls a model. The product does not import this runner or its proof renderer.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { explanationInputSchema, explanationsMatch, requestIdSchema } from '../shared/contracts.ts';
import { referenceInstruction } from './lib/explanation-lexical-reference.mjs';
import { renderTypedReferenceProof, typedReferenceCatalog } from './lib/explanation-typed-reference.mjs';
import { inspectContinuationLedger, reserveContinuationCall, finishContinuationCall } from './lib/model-call-continuation.mjs';

const experimentId = 'issue22-typed-reference-20261122';
const fixturePath = 'tests/fixtures/issue22-original-gate-2026-11-22.json';
const ledgerPath = 'docs/evaluations/approved-model-calls-continuation-2026-11-22.json';
const frozenGateSha256 = '5239faea33683c1063633be6de40e1852c35e5319d231ce3b2495ede03b8db2d';
const frozenCaseHashes = { 'R-03': '2ce6485221684ee12af6c4642531c40903c664bce8e3529f2024f28fb491064a',
  'E-04': 'a6b6f13be2c607fe150bc89bcc8949935264d8f0a0c1795b63f48e4b1dbcba97' };
const models = { elice: 'gpt-4o-mini', gemini: 'gemini-3.5-flash-lite' };
const perProviderMaxCalls = 2;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const canonicalHash = value => hash(JSON.stringify(canonical(value)));

// Keep the existing substantive rules. Replace only the input catalog name,
// quotation representation and JSON output contract, asserting each old line.
export function buildTypedReferenceInstruction(base = referenceInstruction) {
  const replacements = [
    ['표현을 인용할 때 원문 인용은 sourceText에, 수정 표현 인용은 해당 후보에 실제로 존재하는 연속 문자열을 공백까지 그대로 사용한다.',
      '표현을 인용할 때 input_quote를 사용한다. from이 source이면 sourceText에, candidate이면 해당 후보에 실제로 존재하는 연속 문자열을 공백까지 그대로 quote에 쓴다.'],
    ['lexicalReferences는 단어 뜻의 참고 자료이며 특정 후보의 정답이나 사용자의 의도가 아니다. 현재 문장의 실제 문맥에 적용되는지 확인한다.',
      'typedReferenceCatalog는 단어 뜻의 참고 자료이며 특정 후보의 정답이나 사용자의 의도가 아니다. 현재 문장의 실제 문맥에 적용되는지 확인한다.'],
    ['인용은 현재 sourceText 또는 해당 후보에 실제로 존재하는 표현에만 사용하고, 원문·후보에 없는 용어 풀이에는 인용 부호를 쓰지 않는다.',
      'input_quote는 현재 sourceText 또는 해당 후보에 실제로 존재하는 표현에만 사용한다. 사전 용어를 참조할 때는 lexical_reference에 typedReferenceCatalog의 고정 id만 쓴다. 입력에 없는 용어를 input_quote로 만들지 않는다.'],
    ['JSON 객체 {"explanations":[{"candidateId":"입력 id","explanation":"설명"}]}만 반환한다.',
      'JSON 객체 {"explanations":[{"candidateId":"입력 id","segments":[{"kind":"text","text":"일반 설명"},{"kind":"input_quote","from":"source","quote":"해당 입력의 실제 구절"},{"kind":"lexical_reference","id":"참고 자료의 id"}]}]}만 반환한다.'],
  ];
  let result = base;
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) throw new Error('Frozen instruction replacement no longer matches exactly once.');
    result = result.replace(before, after);
  }
  return result + `
설명은 읽을 순서의 segments로 작성하며, 후보당 1~16개다. 세 종류 중 필요한 것만 사용하고 사전 항목을 억지로 추가하지 않는다.
text에는 일반 설명만 적는다. 모든 인용 부호와 백틱, 서버 전용 표시인 [사전 용어: ...]를 쓰지 않는다. 나뉜 text 조각으로 인용이나 사전 표시를 만들지도 않는다.
input_quote의 from은 source 또는 candidate이며 quote는 해당 입력의 정확한 구절이다. 이번 진단은 인용 부호가 포함된 구절의 중첩 인용을 지원하지 않는다. 인용 부호를 지우거나 원문을 바꾸어 넣지 않는다.
lexical_reference에는 kind와 id만 쓴다. 용어명·정의·URL·별도 label을 생성하지 않는다. 서버가 [사전 용어: 용어명]으로 구분해 표시하며, 이것을 원문에 있거나 이미 수정된 표현이라고 서술하지 않는다.
서버가 각 input_quote를 인용 부호로 감싸고 사전 용어 표시를 넣은 뒤 모든 segments를 순서대로 붙인다. 공백과 조사는 text에 적절하게 포함한다. 최종 표시도 한국어 1~2문장·총 400자 이내다. 정의 전문은 화면 설명에 붙이지 않는다.
타입과 출처를 맞췄다는 사실은 단어가 문맥에 맞거나 모든 오류가 해결됐다는 증거가 아니다. 실제 변경과 후보에 남은 문제를 계속 구분한다.`;
}
export const typedReferenceInstruction = buildTypedReferenceInstruction();

export function buildTypedReferenceInput(fixtureCase) {
  const parsed = explanationInputSchema.safeParse({ requestId: 'typed-reference-diagnosis',
    sourceText: fixtureCase.sourceText, candidates: fixtureCase.candidates });
  if (!parsed.success) throw new Error('Invalid fixed source/candidate input.');
  return { sourceText: parsed.data.sourceText, candidates: structuredClone(parsed.data.candidates),
    typedReferenceCatalog: typedReferenceCatalog.map(entry => ({ ...entry })) };
}

export function buildTypedReferencePlan(gate) {
  if (canonicalHash(gate) !== frozenGateSha256) throw new Error('Frozen gate content changed.');
  return Object.keys(frozenCaseHashes).map(caseId => {
    const matches = gate.cases.filter(c => c.id === caseId);
    if (matches.length !== 1 || canonicalHash(matches[0]) !== frozenCaseHashes[caseId]) throw new Error('Frozen case changed.');
    return { caseId, input: buildTypedReferenceInput(matches[0]) };
  });
}

export function typedReferenceResponseSchema(candidateIds) {
  const variant = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  return { type: 'object', properties: { explanations: { type: 'array', minItems: 1, maxItems: 3, items: variant({
    candidateId: { type: 'string', enum: [...candidateIds] }, segments: { type: 'array', minItems: 1, maxItems: 16, items: { anyOf: [
      variant({ kind: { type: 'string', enum: ['text'] }, text: { type: 'string', minLength: 1, maxLength: 400 } }),
      variant({ kind: { type: 'string', enum: ['input_quote'] }, from: { type: 'string', enum: ['source', 'candidate'] }, quote: { type: 'string', minLength: 1, maxLength: 2000 } }),
      variant({ kind: { type: 'string', enum: ['lexical_reference'] }, id: { type: 'string', enum: typedReferenceCatalog.map(entry => entry.id) } }),
    ] } },
  }) } }, required: ['explanations'], additionalProperties: false };
}

const ownershipSchema = z.object({ explanations: z.array(z.object({ candidateId: requestIdSchema }).passthrough()).min(1).max(3) }).strict();
export function diagnoseTypedReferenceOutput(input, raw) {
  const expectedInput = buildTypedReferenceInput(input);
  if (JSON.stringify(input) !== JSON.stringify(expectedInput)) throw new Error('Unexpected model input fields or catalog mutation.');
  const envelope = ownershipSchema.safeParse(raw);
  if (!envelope.success || !explanationsMatch(input.candidates, envelope.data.explanations)) {
    return { envelopeValidation: { ok: false, error: 'candidate-ownership-or-envelope' }, candidateProofResults: [], semanticAssessment: 'not-performed' };
  }
  return { envelopeValidation: { ok: true },
    candidateProofResults: input.candidates.map(candidate => ({ candidateId: candidate.id,
      proof: renderTypedReferenceProof(input.sourceText, [candidate],
        { explanations: [envelope.data.explanations.find(item => item.candidateId === candidate.id)] }),
    })), semanticAssessment: 'not-performed' };
}

function configuration(provider) {
  const model = process.env[provider === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
  const apiKey = process.env[provider === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
  if (model !== models[provider] || !apiKey) throw new Error('Provider configuration mismatch.');
  if (provider === 'gemini') return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    settings: { candidateCount: 1, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'LOW' }, responseMimeType: 'application/json' } };
  const url = new URL(process.env.ELICE_BASE_URL?.trim());
  if (url.protocol !== 'https:' || url.hostname !== 'mlapi.run' || url.port || url.username || url.password || url.search || url.hash
    || !/^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\/v1)?\/?$/i.test(url.pathname)) throw new Error('Provider configuration mismatch.');
  return { url: `${url.origin}${url.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    settings: { model, response_format: { type: 'json_object' }, n: 1, stream: false, max_tokens: 2000 } };
}

function saveReport(path, report) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600); created = true;
    writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path); created = false;
  } finally { if (descriptor !== undefined) closeSync(descriptor); if (created) unlinkSync(temporary); }
}

export function captureTypedReferenceCompletion(provider, envelope, run) {
  const respondedModel = provider === 'gemini' ? envelope.modelVersion : envelope.model;
  if (typeof respondedModel === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(respondedModel)
    && !/^(?:sk-|AIza)/.test(respondedModel)) run.respondedModel = respondedModel;
  const usage = provider === 'gemini' ? envelope.usageMetadata : envelope.usage;
  const keys = provider === 'gemini' ? ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
    : ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  run.tokenUsage = Object.fromEntries(keys.filter(key => Number.isFinite(usage?.[key])).map(key => [key, usage[key]]));
  const choices = provider === 'gemini' ? envelope.candidates : envelope.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : undefined;
  run.rawCompletion = provider === 'gemini'
    ? { finishReason: choice?.finishReason, text: choice?.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('') ?? null }
    : { finishReason: choice?.finish_reason, text: typeof choice?.message?.content === 'string' ? choice.message.content : null };
  run.rawCompletionTextAvailable = typeof run.rawCompletion.text === 'string';
  if (run.rawCompletionTextAvailable) {
    try { run.parsedModelOutput = JSON.parse(run.rawCompletion.text); }
    catch { run.rawParseError = 'completion-json'; }
  }
  const blocked = provider === 'gemini' ? Boolean(envelope.promptFeedback?.blockReason) : Boolean(choice?.message?.refusal);
  run.modelEnvelopeValidation = { ok: Boolean(choice) && !blocked && run.rawCompletionTextAvailable
    && run.rawCompletion.finishReason === (provider === 'gemini' ? 'STOP' : 'stop') };
  if (!run.modelEnvelopeValidation.ok) run.modelEnvelopeValidation.error = 'blocked-missing-or-incomplete-completion';
  if (run.modelEnvelopeValidation.ok && !run.rawParseError) {
    try { run.diagnosis = diagnoseTypedReferenceOutput(run.sentInput, run.parsedModelOutput); }
    catch { run.diagnosisError = 'proof-diagnosis-failed'; }
  }
}

export async function runTypedReference(args = process.argv.slice(2)) {
  if (args.some(arg => !['--provider=elice', '--provider=gemini', '--live'].includes(arg))
    || args.filter(arg => arg.startsWith('--provider=')).length !== 1 || new Set(args).size !== args.length) {
    throw new Error('Use --provider=elice|gemini [--live]. Default is dry-run.');
  }
  const provider = args.find(arg => arg.startsWith('--provider=')).slice('--provider='.length);
  const gate = JSON.parse(readFileSync(fixturePath, 'utf8')), plan = buildTypedReferencePlan(gate);
  const reportPath = `docs/evaluations/explanation-typed-reference-2026-11-22-${provider}.json`;
  const instructionSha256 = hash(typedReferenceInstruction);
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ dryRun: true, experimentId, provider, model: models[provider],
      plan: plan.map(entry => ({ caseId: entry.caseId, candidateIds: entry.input.candidates.map(candidate => candidate.id) })),
      perProviderMaxCalls, totalPlannedAcrossProviders: 4, frozenGateSha256, frozenCaseHashes, instructionSha256,
      catalog: typedReferenceCatalog, catalogSha256: canonicalHash(typedReferenceCatalog), reportPath,
      notes: 'No .env access, writes or model calls. Direct diagnosis, not the product explanation API.' })); return;
  }
  const ledger = inspectContinuationLedger(ledgerPath);
  if (ledger.calls.some(call => call.experimentId === experimentId && call.provider === provider)) throw new Error('This experiment/provider has previous attempts; do not replay.');
  const files = [fixturePath, ledgerPath, ledger.previousLedger.path, 'scripts/evaluate-explanation-typed-reference.mjs',
    'scripts/lib/model-call-continuation.mjs', 'scripts/lib/explanation-typed-reference.mjs', 'scripts/lib/explanation-lexical-reference.mjs',
    'shared/contracts.ts', 'server/llm/prompt.ts', 'server/llm/gemini.ts', 'server/llm/elice.ts', 'package-lock.json'];
  const report = { experimentId, startedAt: new Date().toISOString(), provider, model: models[provider],
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    implementationSha256: Object.fromEntries(files.map(path => [path, hash(readFileSync(path))])),
    frozenGateSha256, frozenCaseHashes, instruction: typedReferenceInstruction, instructionSha256,
    catalog: typedReferenceCatalog, catalogSha256: canonicalHash(typedReferenceCatalog), plan,
    cases: Object.keys(frozenCaseHashes).map(id => gate.cases.find(c => c.id === id)), perProviderMaxCalls,
    priorAuthorization: { previousLedger: ledger.previousLedger, authorization: ledger.authorization, callsAtStart: ledger.calls.length },
    path: 'Direct provider diagnostic schema -> whole-response ownership validation -> independent per-candidate offline proof.',
    limits: 'Not the product API or display policy. No simultaneous baseline or quality gate. Dictionary provenance and valid segments do not prove meaning, residual-error coverage, sentence-count compliance or user value. Nested quotes are conservatively unsupported.',
    modelCalls: 0, state: 'preflight', completed: false, runs: [], unexecuted: plan.map(entry => entry.caseId) };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const save = () => { report.unexecuted = plan.filter(entry => !report.runs.some(run => run.caseId === entry.caseId && run.callId)).map(entry => entry.caseId); saveReport(reportPath, report); };
  try {
    loadEnvFile('.env');
    const config = configuration(provider); report.state = 'running'; save();
    for (const entry of plan) {
      const sentInput = buildTypedReferenceInput(entry.input);
      const responseSchema = typedReferenceResponseSchema(sentInput.candidates.map(candidate => candidate.id));
      const settings = provider === 'gemini' ? { ...config.settings, responseJsonSchema: responseSchema } : config.settings;
      const run = { caseId: entry.caseId, sentInput, sentInputSha256: canonicalHash(sentInput), requestSettings: settings,
        responseSchema, responseSchemaSha256: canonicalHash(responseSchema), startedAt: new Date().toISOString(), state: 'pending', semanticAssessment: 'not-performed' };
      const body = provider === 'gemini' ? { systemInstruction: { parts: [{ text: typedReferenceInstruction }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(sentInput) }] }], generationConfig: settings }
        : { ...settings, messages: [{ role: 'system', content: typedReferenceInstruction }, { role: 'user', content: JSON.stringify(sentInput) }] };
      const signal = AbortSignal.timeout(45_000); signal.throwIfAborted();
      run.callId = reserveContinuationCall(ledgerPath, { experimentId, label: entry.caseId, provider, model: models[provider] }, perProviderMaxCalls);
      report.modelCalls++; run.callState = 'reserved-result-unknown'; report.runs.push(run); save();
      const started = Date.now(); let response;
      try { response = await fetch(config.url, { method: 'POST', redirect: 'error', headers: config.headers, signal, body: JSON.stringify(body) }); }
      catch { finishContinuationCall(ledgerPath, run.callId, { status: 'failed' }); run.callState = 'fetch-failed';
        run.transportError = signal.aborted ? 'timeout' : 'request-failed'; report.stopReason = run.transportError; }
      if (response) {
        finishContinuationCall(ledgerPath, run.callId, { status: 'received', httpStatus: response.status });
        run.callState = 'response-received'; run.upstreamStatus = response.status;
        if (!response.ok) {
          run.rawOutputStatus = 'not-captured-for-non-success-response';
          run.serviceError = [400, 401, 403, 404, 422].includes(response.status) ? 'configuration'
            : [402, 429].includes(response.status) ? 'quota' : 'unavailable'; report.stopReason = run.serviceError;
          try { await response.body?.cancel(); } catch { /* never read an error body */ }
        } else {
          let envelope;
          try { envelope = await response.json(); }
          catch { run.rawCompletionTextAvailable = false; run.captureError = 'response-json-unreadable-no-raw-output'; }
          if (!run.captureError) {
            try { captureTypedReferenceCompletion(provider, envelope, run); }
            catch {
              // Never discard a completion already captured before a later validation failure.
              if (run.rawCompletionTextAvailable) run.diagnosisError = 'completion-validation-failed';
              else { run.rawCompletionTextAvailable = false; run.captureError = 'completion-capture-failed-no-raw-output'; }
            }
          }
          if (run.captureError || run.diagnosisError) report.stopReason = run.captureError ?? run.diagnosisError;
        }
      }
      run.elapsedMs = Date.now() - started; run.finishedAt = new Date().toISOString(); run.state = 'finished'; save();
      console.log(JSON.stringify({ caseId: run.caseId, upstreamStatus: run.upstreamStatus, modelCalls: report.modelCalls,
        modelEnvelopeValid: run.modelEnvelopeValidation?.ok, outputEnvelopeValid: run.diagnosis?.envelopeValidation.ok,
        candidateProof: run.diagnosis?.candidateProofResults.map(result => ({ candidateId: result.candidateId, ok: result.proof.ok, error: result.proof.error })), stopReason: report.stopReason }));
      if (report.stopReason) break;
    }
  } catch { report.runnerError = 'configuration-or-runner-failed'; process.exitCode = 1; }
  finally { report.finishedAt = new Date().toISOString();
    report.completed = !report.runnerError && !report.stopReason && report.runs.length === plan.length && report.runs.every(run => run.state === 'finished' && run.callId);
    report.state = report.completed ? 'completed' : 'stopped'; save(); }
  console.log(JSON.stringify({ reportPath, modelCalls: report.modelCalls, completed: report.completed, unexecuted: report.unexecuted.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runTypedReference();
