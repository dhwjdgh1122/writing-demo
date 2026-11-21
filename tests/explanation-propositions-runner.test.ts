import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
// @ts-expect-error Manual diagnostic runner imports only pure helpers and the ledger; CLI is guarded.
import { buildPropositionPlan, buildPropositionRequest, capturePropositionCompletion, runPropositions } from '../scripts/evaluate-explanation-propositions.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/explanation-propositions-2026-11-22.json', import.meta.url), 'utf8'));
const input = buildPropositionPlan(fixture)[0].input;
const decoded = { propositions: [{ id: 'h1', statement: '회원만 자료를 받을 수 있다.', originId: 't1', quote: input.texts[0].text }] };
const completion = JSON.stringify(decoded);
const elice = (content: unknown) => ({ model: 'gpt-4o-mini-2024-07-18', choices: [{ finish_reason: 'stop', message: { content } }] });

test('frozen plan sends texts only and preserves report-only source criteria without mutation', () => {
  const before = JSON.stringify(fixture), plan = buildPropositionPlan(fixture);
  assert.deepEqual(plan.map((x: { caseId: string }) => x.caseId), ['CT-03', 'EQ-03', 'E-03']);
  assert.equal(new Set(plan.map((x: { label: string }) => x.label)).size, 3);
  for (const entry of plan) {
    const original = fixture.cases.find((x: { id: string }) => x.id === entry.caseId);
    assert.deepEqual(entry.input, { texts: [{ id: 't1', text: original.sourceText }, { id: 't2', text: original.candidates[0].text }] });
  }
  plan[0].input.texts[0].text = 'changed copy';
  assert.equal(JSON.stringify(fixture), before);
  const crlfFixture = JSON.parse(JSON.stringify(fixture, null, 2).replace(/\n/g, '\r\n'));
  assert.deepEqual(buildPropositionPlan(crlfFixture), buildPropositionPlan(fixture));
  const modified = structuredClone(fixture); modified.cases[0].sourceText += ' changed';
  assert.throws(() => buildPropositionPlan(modified), /Frozen proposition fixture/);
  const answers = structuredClone(fixture); answers.cases[0].required.push('injected answer');
  assert.throws(() => buildPropositionPlan(answers), /Frozen proposition fixture/);
});

test('both provider bodies use the same input/instruction with existing settings and no answer or role fields', () => {
  const before = JSON.stringify(input), a = buildPropositionRequest('elice', input), b = buildPropositionRequest('gemini', input);
  assert.equal(a.messages[0].content, b.systemInstruction.parts[0].text);
  assert.deepEqual(JSON.parse(a.messages[1].content), input);
  assert.deepEqual(JSON.parse(b.contents[0].parts[0].text), input);
  assert.equal(a.model, 'gpt-4o-mini'); assert.equal(a.max_tokens, 2000);
  assert.equal(a.n, 1); assert.equal(a.stream, false); assert.deepEqual(a.response_format, { type: 'json_object' });
  assert.equal(b.generationConfig.maxOutputTokens, 8192); assert.equal(b.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(b.generationConfig.candidateCount, 1);
  assert.equal(Object.hasOwn(a, 'temperature'), false);
  for (const provider of ['elice', 'gemini']) {
    assert.throws(() => buildPropositionRequest(provider, { ...input, required: ['answer'] }), /Only two bounded texts/);
  }
  assert.throws(() => buildPropositionRequest('other', input), /Unsupported diagnostic provider/);
  assert.equal(JSON.stringify(input), before);
});

test('capture retains raw outputs and safe metadata while structural success does not become semantic success', () => {
  const envelope = { ...elice(completion), apiKey: 'should-not-copy', usage: { total_tokens: 12, unknown: 'should-not-copy' } };
  const before = JSON.stringify(envelope), a = capturePropositionCompletion('elice', envelope, input);
  const b = capturePropositionCompletion('gemini', { modelVersion: 'gemini-3.5-flash-lite', candidates: [{ finishReason: 'STOP',
    content: { parts: [{ thought: true, text: 'private reasoning' }, { text: completion }] } }], usageMetadata: { totalTokenCount: 13 } }, input);
  for (const captured of [a, b]) {
    assert.equal(captured.rawCompletion.text, completion);
    assert.deepEqual(captured.parsedModelOutput, decoded);
    assert.equal(captured.propositionValidation.ok, true);
    assert.equal(captured.semanticAssessment, 'not-performed');
    assert.equal(Object.hasOwn(captured, 'qualityPassed'), false);
    assert.equal(Object.hasOwn(captured, 'apiKey'), false);
    assert.equal(JSON.stringify(captured).includes('private reasoning'), false);
  }
  assert.deepEqual(a.tokenUsage, { total_tokens: 12 });
  assert.equal(JSON.stringify(envelope), before);
  assert.equal(capturePropositionCompletion('elice', { ...envelope, model: 'sk-not-a-model' }, input).respondedModel, undefined);
});

test('missing, blank and non-string completions stop capture while malformed nonblank JSON remains reviewable', () => {
  for (const value of [undefined, null, '', ' \n\t ', {}, [], 123]) {
    const captured = capturePropositionCompletion('elice', elice(value), input);
    assert.equal(captured.rawCompletionTextAvailable, false);
    assert.equal(captured.captureError, 'completion-text-unavailable');
    assert.deepEqual(captured.rawCompletion.text, value ?? null);
  }
  for (const envelope of [null, {}, { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'reasoning only' }] } }] }]) {
    assert.equal(capturePropositionCompletion('gemini', envelope, input).captureError, 'completion-text-unavailable');
  }
  const malformed = capturePropositionCompletion('elice', elice('not json'), input);
  assert.equal(malformed.rawCompletionTextAvailable, true); assert.equal(malformed.rawCompletion.text, 'not json');
  assert.equal(malformed.validationError, 'completion-json'); assert.equal(malformed.captureError, undefined);
  const wrongQuote = JSON.stringify({ propositions: [{ ...decoded.propositions[0], quote: 'not in input' }] });
  const invalid = capturePropositionCompletion('elice', elice(wrongQuote), input);
  assert.equal(invalid.rawCompletion.text, wrongQuote);
  assert.equal(invalid.validationError, 'quote-not-in-own-text'); assert.equal(invalid.captureError, undefined);
  const blocked = capturePropositionCompletion('elice', { choices: [{ finish_reason: 'length', message: { content: completion } }] }, input);
  assert.equal(blocked.rawCompletion.text, completion); assert.equal(blocked.validationError, 'blocked-or-incomplete-completion');
});

test('CLI requires both explicit live flags and dry-run leaves the ledger and outputs unchanged', async () => {
  for (const args of [[], ['--provider=elice', '--live'], ['--provider=elice', '--confirm-authorized'],
    ['--provider=elice', '--provider=gemini'], ['--provider=elice', '--live', '--confirm-authorized', '--live']]) {
    await assert.rejects(() => runPropositions(args), /Use --provider/);
  }
  const ledgerPath = new URL('../docs/evaluations/approved-model-calls-continuation-2026-11-22.json', import.meta.url);
  const beforeLedger = readFileSync(ledgerPath, 'utf8');
  for (const provider of ['elice', 'gemini']) {
    const report = new URL(`../docs/evaluations/explanation-propositions-2026-11-22-${provider}.json`, import.meta.url);
    const before = existsSync(report) ? readFileSync(report, 'utf8') : null;
    const preview = await runPropositions([`--provider=${provider}`]);
    assert.equal(preview.dryRun, true); assert.equal(preview.perProviderMaxCalls, 3);
    assert.equal(preview.totalPlannedAcrossProviders, 6); assert.equal(preview.plan.length, 3);
    assert.equal(existsSync(report) ? readFileSync(report, 'utf8') : null, before);
  }
  assert.equal(readFileSync(ledgerPath, 'utf8'), beforeLedger);
});
