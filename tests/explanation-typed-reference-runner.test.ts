import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
// @ts-expect-error Manual JavaScript runner is guarded and does not call a model on import.
import { buildTypedReferenceInstruction, typedReferenceInstruction, buildTypedReferenceInput, buildTypedReferencePlan, diagnoseTypedReferenceOutput, typedReferenceResponseSchema, captureTypedReferenceCompletion } from '../scripts/evaluate-explanation-typed-reference.mjs';
// @ts-expect-error Existing evaluation instruction is the fixed substantive baseline.
import { referenceInstruction } from '../scripts/lib/explanation-lexical-reference.mjs';
const gate = JSON.parse(readFileSync(new URL('./fixtures/issue22-original-gate-2026-11-22.json', import.meta.url), 'utf8'));

test('instruction replaces representation rules exactly once while retaining substantive limits and residual-error rules', () => {
  assert.equal(buildTypedReferenceInstruction(), typedReferenceInstruction);
  for (const text of ['한국어 1~2문장, 최대 400자로 설명한다.',
    '후보에 그대로 남은 단어라도 문맥상 명백히 맞지 않으면',
    '참고 단어가 있다는 이유만으로 오류를 찾거나 모호한 상황을 지불·승인으로 단정하지 않는다.',
    '입력에 없는 용어를 input_quote로 만들지 않는다.']) {
    assert.equal(typedReferenceInstruction.includes(text), true);
  }
  assert.equal(typedReferenceInstruction.includes('"explanation":"설명"'), false);
  assert.equal(typedReferenceInstruction.includes('lexicalReferences'), false);
  assert.equal(typedReferenceInstruction.includes('"segments"'), true);
  assert.throws(() => buildTypedReferenceInstruction(referenceInstruction.replace('lexicalReferences는', 'changed는')), /exactly once/);
  assert.throws(() => buildTypedReferenceInstruction(referenceInstruction + '\n' + referenceInstruction), /exactly once/);
});

test('fixed plan includes only R-03/E-04 and input strips answers and cannot accept candidate metadata', () => {
  const before = JSON.stringify(gate), plan = buildTypedReferencePlan(gate);
  assert.deepEqual(plan.map((item: { caseId: string }) => item.caseId), ['R-03', 'E-04']);
  for (const entry of plan) {
    assert.deepEqual(Object.keys(entry.input), ['sourceText', 'candidates', 'typedReferenceCatalog']);
    assert.equal(entry.input.typedReferenceCatalog.length, 2);
    for (const candidate of entry.input.candidates) assert.deepEqual(Object.keys(candidate), ['id', 'text']);
    entry.input.candidates[0].text = 'mutated'; entry.input.typedReferenceCatalog[0].definition = 'mutated';
  }
  assert.equal(JSON.stringify(gate), before);
  const fixture = gate.cases.find((c: { id: string }) => c.id === 'R-03');
  const input = buildTypedReferenceInput({ ...fixture, required: ['private answer'], expected: true, previousOutput: 'do not send' });
  assert.equal(JSON.stringify(input).includes('private answer'), false);
  assert.throws(() => buildTypedReferenceInput({ ...fixture, candidates: [{ ...fixture.candidates[0], expected: true }] }), /Invalid fixed/);
  const changed = structuredClone(gate); changed.cases[0].sourceText += 'changed';
  assert.throws(() => buildTypedReferencePlan(changed), /Frozen gate/);
});

test('whole-response candidate ownership is checked before independent proof results preserve a valid sibling', () => {
  const input = buildTypedReferencePlan(gate)[1].input;
  const good = { candidateId: 'e04-p1', segments: [{ kind: 'input_quote', from: 'candidate', quote: '결제하지 않았습니다' }] };
  const bad = { candidateId: 'e04-p2', segments: [{ kind: 'input_quote', from: 'candidate', quote: '결제하지 않았습니다' }] };
  const raw = { explanations: [good, bad] }, before = JSON.stringify({ input, raw });
  const result = diagnoseTypedReferenceOutput(input, raw);
  assert.equal(result.envelopeValidation.ok, true);
  assert.equal(result.candidateProofResults[0].proof.ok, true);
  assert.equal(result.candidateProofResults[1].proof.error, 'quote-not-in-declared-input');
  assert.equal(result.semanticAssessment, 'not-performed');
  assert.equal(JSON.stringify({ input, raw }), before);
  for (const value of [{ explanations: [good] }, { explanations: [good, good] },
    { explanations: [good, { ...bad, candidateId: 'foreign' }] }, { ...raw, expected: true }]) {
    const invalid = diagnoseTypedReferenceOutput(input, value);
    assert.equal(invalid.envelopeValidation.ok, false); assert.deepEqual(invalid.candidateProofResults, []);
  }
  assert.throws(() => diagnoseTypedReferenceOutput({ ...input, expected: 'answer' }, raw), /Unexpected model input/);
  const tampered = structuredClone(input); tampered.typedReferenceCatalog[0].definition = 'answer';
  assert.throws(() => diagnoseTypedReferenceOutput(tampered, raw), /Unexpected model input/);
});

test('provider schema strictly separates the three segment variants and product sources do not import the diagnosis', () => {
  const schema = typedReferenceResponseSchema(['e04-p1', 'e04-p2']);
  const item = schema.properties.explanations.items;
  assert.deepEqual(item.properties.candidateId.enum, ['e04-p1', 'e04-p2']);
  const variants = item.properties.segments.items.anyOf;
  assert.equal(variants.length, 3);
  for (const variant of variants) assert.equal(variant.additionalProperties, false);
  assert.deepEqual(variants[2].required, ['kind', 'id']);
  assert.equal(item.properties.segments.maxItems, 16);
  for (const directory of ['../server/', '../client/src/']) {
    for (const path of readdirSync(new URL(directory, import.meta.url), { recursive: true }) as string[]) {
      if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
      const text = readFileSync(new URL(directory + path.replace(/\\/g, '/'), import.meta.url), 'utf8');
      assert.equal(/(?:import|require)[^\n]*explanation-typed-reference/.test(text), false, path);
    }
  }
});

test('a proof diagnosis exception preserves the already captured raw response and parsed model output', () => {
  const input = buildTypedReferencePlan(gate)[0].input;
  const output = { explanations: [{ candidateId: 'r03-c1', segments: [{ kind: 'text', text: '진단용 설명입니다.' }] }] };
  const raw = JSON.stringify(output);
  const run: Record<string, any> = { sentInput: { ...input, expected: 'unexpected metadata' } };
  captureTypedReferenceCompletion('elice', { model: 'gpt-4o-mini', usage: { completion_tokens: 12 },
    choices: [{ finish_reason: 'stop', message: { content: raw } }] }, run);
  assert.equal(run.modelEnvelopeValidation.ok, true);
  assert.equal(run.diagnosisError, 'proof-diagnosis-failed');
  assert.equal(run.rawCompletionTextAvailable, true);
  assert.equal(run.rawCompletion.text, raw);
  assert.deepEqual(run.parsedModelOutput, output);
  assert.equal(run.captureError, undefined);
  assert.equal(run.diagnosis, undefined);
});
