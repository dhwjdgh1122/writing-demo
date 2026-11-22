import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
// @ts-expect-error Manual JavaScript runner: importing it never invokes the guarded CLI.
import { buildReviewPlan, buildReviewRequest, captureReviewCompletion, executeReviewPlan, runPropositionReview } from '../scripts/evaluate-explanation-proposition-review.mjs';

const fixtureUrl = new URL('./fixtures/explanation-propositions-2026-11-22.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const plan = buildReviewPlan(fixture);
const input = plan[0].input;
const metadata = { runId: 'offline-runner-test', requestId: 'offline-request-test' };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const decoded = { propositions: [{ id: 'h1', statement: '회원만 자료를 받을 수 있다.', originId: 't1' }] };
const completion = JSON.stringify(decoded);
const elice = (content: unknown, finishReason = 'stop') => ({ model: 'gpt-4o-mini-2024-07-18',
  choices: [{ finish_reason: finishReason, message: { content } }] });
const gemini = (content: string, finishReason = 'STOP') => ({ modelVersion: 'gemini-3.5-flash-lite',
  candidates: [{ finishReason, content: { parts: [{ text: content }] } }] });
function assertNoSemanticPass(value: any) {
  assert.equal(value.semanticAssessment, 'not-performed');
  for (const key of ['qualityPassed', 'complete', 'faithful', 'equivalent', 'entailed']) {
    assert.equal(Object.hasOwn(value, key), false, `must not claim ${key}`);
  }
}
function validEnvelope(provider: string, entry: any) {
  const text = JSON.stringify({ propositions: [{ id: 'h1', statement: entry.input.texts[0].text, originId: 't1' }] });
  return provider === 'gemini' ? gemini(text) : elice(text);
}
function fakeCore(provider = 'elice', response?: (entry: any, index: number) => any) {
  const calls: any[] = [], reservations: any[] = [], finishes: any[] = [], saves: any[] = [], logs: any[] = [], order: string[] = [];
  const options = {
    provider, plan: buildReviewPlan(fixture), runId: `fake-${provider}-run`,
    reserve: (entry: any) => {
      const callId = `fake-${provider}-call-${reservations.length + 1}`;
      reservations.push({ entry: structuredClone(entry), callId }); order.push(`reserve:${callId}`); return callId;
    },
    call: async (entry: any, body: any, callId: string) => {
      calls.push({ entry: structuredClone(entry), body: structuredClone(body), callId }); order.push(`call:${callId}`);
      return response ? response(entry, calls.length - 1) : { status: 200, envelope: validEnvelope(provider, entry) };
    },
    finish: (callId: string, outcome: any) => { finishes.push({ callId, ...outcome }); order.push(`finish:${callId}`); },
    save: (report: any) => { saves.push(structuredClone(report)); order.push(`save:${report.modelCalls}`); },
    log: (value: any) => { logs.push(structuredClone(value)); },
  };
  return { options, calls, reservations, finishes, saves, logs, order };
}

test('the review plan reuses frozen CT/EQ/E inputs and cannot smuggle changed text or answer metadata', () => {
  const before = JSON.stringify(fixture), built = buildReviewPlan(fixture);
  assert.deepEqual(built.map((entry: any) => entry.caseId), ['CT-03', 'EQ-03', 'E-03']);
  assert.deepEqual(built.map((entry: any) => entry.label), ['CT-03-proposition-review', 'EQ-03-proposition-review', 'E-03-proposition-review']);
  for (const entry of built) {
    const source = fixture.cases.find((item: any) => item.id === entry.caseId);
    assert.deepEqual(entry.input, { texts: [{ id: 't1', text: source.sourceText }, { id: 't2', text: source.candidates[0].text }] });
    assert.deepEqual(Object.keys(entry.input), ['texts']);
  }
  assert.equal(JSON.stringify(fixture), before);
  const mutations = [
    (value: any) => { value.cases[0].sourceText += ' changed'; },
    (value: any) => { value.cases[0].required.push('private answer'); },
    (value: any) => { value.cases[0].candidates.push(value.cases[0].candidates[0]); },
    (value: any) => { value.cases[0].previousOutput = 'do not leak'; },
  ];
  for (const mutate of mutations) { const altered = structuredClone(fixture); mutate(altered); assert.throws(() => buildReviewPlan(altered)); }
  const changedLayout = JSON.parse(JSON.stringify(fixture, null, 2).replace(/\n/g, '\r\n'));
  assert.deepEqual(buildReviewPlan(changedLayout), buildReviewPlan(fixture));
});

test('both provider requests share text-only input and a strict quote-free contract with existing settings', () => {
  const before = JSON.stringify(input), a = buildReviewRequest('elice', input), b = buildReviewRequest('gemini', input);
  assert.equal(a.messages[0].content, b.systemInstruction.parts[0].text);
  assert.deepEqual(JSON.parse(a.messages[1].content), input);
  assert.deepEqual(JSON.parse(b.contents[0].parts[0].text), input);
  assert.equal(a.model, 'gpt-4o-mini'); assert.equal(a.max_tokens, 2000);
  assert.equal(a.n, 1); assert.equal(a.stream, false); assert.deepEqual(a.response_format, { type: 'json_object' });
  assert.equal(b.generationConfig.maxOutputTokens, 8192);
  assert.equal(b.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(b.generationConfig.candidateCount, 1);
  assert.equal(b.generationConfig.responseMimeType, 'application/json');
  assert.equal(Object.hasOwn(a, 'temperature'), false);
  const schema = b.generationConfig.responseJsonSchema, items = schema.properties.propositions.items;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.propositions.minItems, 1); assert.equal(schema.properties.propositions.maxItems, 8);
  assert.deepEqual(items.required, ['id', 'statement', 'originId']);
  assert.deepEqual(Object.keys(items.properties), ['id', 'statement', 'originId']);
  assert.equal(items.additionalProperties, false);
  assert.equal(items.properties.statement.maxLength, 300);
  assert.deepEqual(items.properties.originId.enum, ['t1', 't2']);
  items.properties.originId.enum.push('foreign');
  assert.deepEqual(buildReviewRequest('gemini', input).generationConfig.responseJsonSchema.properties.propositions.items.properties.originId.enum, ['t1', 't2']);
  for (const provider of ['elice', 'gemini']) {
    for (const extra of [{ required: ['answer'] }, { expected: true }, { caseId: 'CT-03' }, { review: 'same' }, { previousOutput: 'answer' }]) {
      assert.throws(() => buildReviewRequest(provider, { ...input, ...extra }));
    }
    assert.throws(() => buildReviewRequest(provider, { texts: [{ ...input.texts[0], role: 'source' }, input.texts[1]] }));
  }
  assert.throws(() => buildReviewRequest('unknown', input));
  assert.equal(JSON.stringify(input), before);
});

test('capture preserves raw completion and request bindings without reasoning, secrets or semantic approval', () => {
  const envelope = { ...elice(completion), apiKey: 'secret-do-not-copy', usage: { total_tokens: 12, unknown: 'secret-do-not-copy' } };
  const before = JSON.stringify(envelope);
  const a = captureReviewCompletion('elice', envelope, input, metadata);
  const b = captureReviewCompletion('gemini', { modelVersion: 'gemini-3.5-flash-lite',
    candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private reasoning' }, { text: completion }] } }],
    usageMetadata: { totalTokenCount: 13, unknown: 'secret-do-not-copy' } }, input, metadata);
  for (const result of [a, b]) {
    assert.equal(result.rawCompletion.text, completion);
    assert.deepEqual(result.parsedModelOutput, decoded);
    assert.equal(result.rawCompletionTextAvailable, true);
    assert.equal(result.reviewValidation.ok, true);
    const snapshot = result.reviewValidation.snapshot;
    assert.equal(snapshot.binding.runId, metadata.runId); assert.equal(snapshot.binding.requestId, metadata.requestId);
    assert.equal(snapshot.binding.contractVersion, 'proposition-review-v1');
    assert.equal(snapshot.rawResponseSha256, hash(completion));
    assert.equal(snapshot.binding.inputSha256, hash(JSON.stringify(input.texts.map(({ id, text }: any) => ({ id, text })))));
    assert.equal(snapshot.binding.outputSha256, hash(JSON.stringify(decoded.propositions)));
    assert.equal(snapshot.propositions[0].sourceContext, input.texts[0].text);
    assert.equal(JSON.stringify(result).includes('private reasoning'), false);
    assert.equal(JSON.stringify(result).includes('secret-do-not-copy'), false);
    assertNoSemanticPass(result); assertNoSemanticPass(snapshot);
  }
  assert.deepEqual(a.tokenUsage, { total_tokens: 12 });
  assert.equal(JSON.stringify(envelope), before);
  assert.equal(captureReviewCompletion('elice', { ...envelope, model: 'sk-not-a-model' }, input, metadata).respondedModel, undefined);
});

test('a quote field is rejected intact and cross-origin duplicates are preserved without automatic grouping', () => {
  const oldContract = JSON.stringify({ propositions: [{ ...decoded.propositions[0], quote: input.texts[0].text }] });
  const failed = captureReviewCompletion('elice', elice(oldContract), input, metadata);
  assert.equal(failed.rawCompletion.text, oldContract);
  assert.equal(failed.parsedModelOutput.propositions[0].quote, input.texts[0].text);
  assert.equal(failed.reviewValidation.ok, false);
  assert.equal(Object.hasOwn(failed.reviewValidation, 'snapshot'), false);
  assert.ok(failed.validationError); assert.equal(failed.captureError, undefined);
  const sameOrigin = JSON.stringify({ propositions: [decoded.propositions[0], { ...decoded.propositions[0], id: 'h2' }] });
  assert.equal(captureReviewCompletion('elice', elice(sameOrigin), input, metadata).reviewValidation.ok, false);
  const crossOrigin = JSON.stringify({ propositions: [decoded.propositions[0], { ...decoded.propositions[0], id: 'h2', originId: 't2' }] });
  const accepted = captureReviewCompletion('elice', elice(crossOrigin), input, metadata);
  assert.equal(accepted.reviewValidation.ok, true);
  assert.equal(accepted.reviewValidation.snapshot.propositions.length, 2);
  assert.equal(Object.hasOwn(accepted, 'groups'), false);
  assertNoSemanticPass(accepted);
  const unsupported = JSON.stringify({ propositions: [{ ...decoded.propositions[0], statement: '비회원도 이미 자료를 받았다.' }] });
  const structuralOnly = captureReviewCompletion('elice', elice(unsupported), input, metadata);
  assert.equal(structuralOnly.reviewValidation.ok, true);
  assertNoSemanticPass(structuralOnly);
});

test('missing completions stop capture while nonblank malformed output is preserved without repair', () => {
  for (const value of [undefined, null, '', ' \r\n\t ', {}, [], 123]) {
    const result = captureReviewCompletion('elice', elice(value), input, metadata);
    assert.equal(result.rawCompletionTextAvailable, false);
    assert.ok(result.captureError);
    assert.notEqual(result.reviewValidation?.ok, true);
  }
  for (const envelope of [null, {}, { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'reasoning only' }] } }] }]) {
    assert.ok(captureReviewCompletion('gemini', envelope, input, metadata).captureError);
  }
  for (const text of ['not json', `\u0060\u0060\u0060json\n${completion}\n\u0060\u0060\u0060`, '{"propositions":']) {
    const result = captureReviewCompletion('elice', elice(text), input, metadata);
    assert.equal(result.rawCompletionTextAvailable, true); assert.equal(result.rawCompletion.text, text);
    assert.ok(result.validationError); assert.equal(result.captureError, undefined);
    assert.notEqual(result.reviewValidation?.ok, true);
    assertNoSemanticPass(result);
  }
});

test('length-limited, refused, blocked and ambiguous multiple completions never become valid snapshots', () => {
  const refusal = elice(completion); Object.assign(refusal.choices[0].message, { refusal: 'refused' });
  const blocked = { ...gemini(completion), promptFeedback: { blockReason: 'SAFETY' } };
  for (const [provider, envelope] of [
    ['elice', elice(completion, 'length')], ['elice', refusal], ['gemini', gemini(completion, 'MAX_TOKENS')], ['gemini', blocked],
    ['elice', { choices: [...elice(completion).choices, ...elice(completion).choices] }],
    ['gemini', { candidates: [...gemini(completion).candidates, ...gemini(completion).candidates] }],
  ] as [string, any][]) {
    const result = captureReviewCompletion(provider, envelope, input, metadata);
    assert.notEqual(result.reviewValidation?.ok, true);
    assert.ok(result.validationError || result.captureError);
    assertNoSemanticPass(result);
  }
});

test('a fake execution reserves and saves each request before dispatch and binds only that call ID', async () => {
  for (const provider of ['elice', 'gemini']) {
    const fake = fakeCore(provider), before = JSON.stringify(fake.options.plan);
    const report = await executeReviewPlan(fake.options);
    assert.equal(report.modelCalls, 3); assert.equal(report.runs.length, 3);
    assert.equal(report.completed, true); assert.deepEqual(report.unexecuted, []);
    assert.equal(fake.calls.length, 3); assert.equal(fake.finishes.length, 3);
    for (let index = 0; index < fake.calls.length; index++) {
      const sent = fake.calls[index], run = report.runs[index];
      const reserveIndex = fake.order.indexOf(`reserve:${sent.callId}`), dispatchIndex = fake.order.indexOf(`call:${sent.callId}`);
      assert.ok(reserveIndex < dispatchIndex);
      assert.ok(fake.order.slice(reserveIndex + 1, dispatchIndex).some(value => value.startsWith('save:')));
      assert.ok(fake.order.indexOf(`finish:${sent.callId}`) > dispatchIndex);
      assert.equal(run.callId, sent.callId);
      assert.equal(run.reviewValidation.ok, true);
      assert.equal(run.reviewValidation.snapshot.binding.requestId, sent.callId);
      assert.equal(run.reviewValidation.snapshot.binding.runId, fake.options.runId);
      assert.deepEqual(run.sentInput, sent.entry.input);
      assert.deepEqual(fake.finishes[index], { callId: sent.callId, status: 'received', httpStatus: 200 });
      assertNoSemanticPass(run);
    }
    assert.equal(JSON.stringify(fake.options.plan), before);
  }
});

test('HTTP service/configuration/quota failures stop that provider without retry or substitute calls', async () => {
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    const fake = fakeCore('elice', () => ({ status, envelope: { error: 'untrusted service error body' } }));
    const report = await executeReviewPlan(fake.options);
    assert.equal(report.modelCalls, 1); assert.equal(fake.calls.length, 1); assert.equal(fake.reservations.length, 1);
    assert.equal(report.completed, false); assert.equal(report.unexecuted.length, 2); assert.ok(report.stopReason);
    assert.deepEqual(fake.finishes, [{ callId: 'fake-elice-call-1', status: 'received', httpStatus: status }]);
    assert.equal(JSON.stringify(report).includes('untrusted service error body'), false);
  }
});

test('transport failure, response capture failure and unavailable completion stop remaining fake requests', async () => {
  const responses = [
    () => ({ status: 0, transportError: 'timeout' }),
    () => { throw new Error('private transport detail'); },
    () => ({ status: 200, captureError: 'response-json-unavailable' }),
    () => ({ status: 200, envelope: elice('') }),
  ];
  for (const response of responses) {
    const fake = fakeCore('elice', response), report = await executeReviewPlan(fake.options);
    assert.equal(fake.calls.length, 1); assert.equal(report.modelCalls, 1);
    assert.equal(report.completed, false); assert.equal(report.unexecuted.length, 2); assert.ok(report.stopReason);
    assert.equal(JSON.stringify(report).includes('private transport detail'), false);
    assert.equal(fake.finishes.length, 1);
  }
});

test('captured malformed JSON or invalid contract is recorded and does not cause repair or retries', async () => {
  const texts = ['not json', JSON.stringify({ propositions: [{ ...decoded.propositions[0], quote: 'old field' }] }), completion];
  const fake = fakeCore('elice', (_entry, index) => ({ status: 200, envelope: elice(texts[index]) }));
  const report = await executeReviewPlan(fake.options);
  assert.equal(fake.calls.length, 3); assert.equal(report.modelCalls, 3);
  assert.equal(report.completed, true); assert.deepEqual(report.unexecuted, []);
  assert.deepEqual(report.runs.map((run: any) => run.rawCompletion.text), texts);
  assert.ok(report.runs[0].validationError); assert.ok(report.runs[1].validationError);
  assert.notEqual(report.runs[0].reviewValidation?.ok, true); assert.notEqual(report.runs[1].reviewValidation?.ok, true);
  assert.equal(report.runs[2].reviewValidation.ok, true);
  for (const run of report.runs) assertNoSemanticPass(run);
});

test('a received completion survives a ledger outcome-write failure and no later request is dispatched', async () => {
  const fake = fakeCore();
  let finishAttempts = 0;
  fake.options.finish = () => { finishAttempts++; throw new Error('private ledger failure details'); };
  const report = await executeReviewPlan(fake.options);
  const expectedText = JSON.stringify({ propositions: [{ id: 'h1', statement: fake.options.plan[0].input.texts[0].text, originId: 't1' }] });
  assert.equal(fake.calls.length, 1); assert.equal(fake.reservations.length, 1); assert.equal(finishAttempts, 1);
  assert.equal(report.modelCalls, 1); assert.equal(report.completed, false);
  assert.equal(report.stopReason, 'ledger-outcome-failed'); assert.equal(report.unexecuted.length, 2);
  const run = report.runs[0];
  assert.equal(run.upstreamStatus, 200); assert.equal(run.rawCompletion.text, expectedText);
  assert.equal(run.rawCompletionSha256, hash(expectedText));
  assert.equal(run.reviewValidation.ok, true);
  assert.equal(run.reviewValidation.snapshot.rawResponseSha256, hash(expectedText));
  assert.equal(run.reviewValidation.snapshot.binding.requestId, fake.calls[0].callId);
  assert.equal(run.ledgerState, 'reserved'); assert.ok(run.ledgerError);
  const savedWithResponse = fake.saves.filter(saved => saved.runs[0]?.rawCompletion?.text === expectedText);
  assert.ok(savedWithResponse.length >= 2, 'the response must be saved before ledger finish and in the final stopped report');
  assert.equal(savedWithResponse[0].runs[0].ledgerState, 'reserved');
  assert.equal(savedWithResponse[0].runs[0].ledgerError, undefined);
  assert.deepEqual(fake.saves.at(-1).runs[0].reviewValidation.snapshot, run.reviewValidation.snapshot);
  assert.equal(JSON.stringify(report).includes('private ledger failure details'), false);
  assertNoSemanticPass(run);
});

test('changed or reordered plans fail before any fake reservation or dispatch', async () => {
  for (const change of [
    (value: any[]) => { value[0].input.texts[0].text += ' changed'; },
    (value: any[]) => { value[0].input.required = ['answer']; },
    (value: any[]) => { value[0].label = 'different-label'; },
    (value: any[]) => { value.reverse(); },
    (value: any[]) => { value.pop(); },
  ]) {
    const fake = fakeCore(); change(fake.options.plan);
    await assert.rejects(() => executeReviewPlan(fake.options));
    assert.equal(fake.calls.length, 0); assert.equal(fake.reservations.length, 0);
  }
});

test('a pre-dispatch save failure cannot send the reserved request or start the next one', async () => {
  const fake = fakeCore();
  let saveAttempts = 0;
  fake.options.save = () => { if (++saveAttempts >= 2) throw new Error('local write failed'); };
  try { await executeReviewPlan(fake.options); } catch { /* stopping may be returned or thrown; neither may dispatch */ }
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.reservations.length, 1);
});

test('CLI defaults to dry-run, rejects incomplete authorization, and leaves evidence unchanged without fetch', async () => {
  for (const args of [[], ['--provider=elice', '--live'], ['--provider=elice', '--confirm-authorized'],
    ['--provider=elice', '--provider=gemini'], ['--provider=elice', '--live', '--confirm-authorized', '--live'],
    ['--provider=other'], ['--provider=elice', '--extra']]) {
    await assert.rejects(() => runPropositionReview(args));
  }
  let fetchCalls = 0;
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network disabled in offline test'); };
  try {
    const watched = ['approved-model-calls-continuation-2026-11-22.json', 'approved-model-calls-2026-11-21.json',
      'explanation-propositions-2026-11-22-elice.json', 'explanation-propositions-2026-11-22-gemini.json'];
    const before = new Map(watched.map(name => [name, hash(readFileSync(new URL(`../docs/evaluations/${name}`, import.meta.url)))]));
    for (const provider of ['elice', 'gemini']) {
      const outputUrl = new URL(`../docs/evaluations/explanation-proposition-review-2026-11-22-${provider}.json`, import.meta.url);
      const prior = existsSync(outputUrl) ? hash(readFileSync(outputUrl)) : null;
      const preview = await runPropositionReview([`--provider=${provider}`]);
      assert.equal(preview.dryRun, true); assert.equal(preview.perProviderMaxCalls, 3);
      assert.equal(preview.totalPlannedAcrossProviders, 6); assert.equal(preview.plan.length, 3);
      assert.equal(new URL(`../${preview.reportPath}`, import.meta.url).href, outputUrl.href);
      assert.equal(existsSync(outputUrl) ? hash(readFileSync(outputUrl)) : null, prior);
    }
    for (const name of watched) assert.equal(hash(readFileSync(new URL(`../docs/evaluations/${name}`, import.meta.url))), before.get(name));
    assert.equal(fetchCalls, 0);
  } finally {
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
  }
});
