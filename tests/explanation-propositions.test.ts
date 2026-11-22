import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Offline JavaScript diagnostic helpers; no model calls on import.
import { propositionInstruction, propositionInput, propositionResponseSchema, validatePropositionResult } from '../scripts/lib/explanation-propositions.mjs';

const input = { texts: [
  { id: 't1', text: '승인되면 화요일까지 8명에게 안내할 예정입니다.' },
  { id: 't2', text: '화요일까지 10명에게 안내합니다.' },
] };
const proposition = { id: 'h1', statement: '승인되면 화요일까지 8명에게 안내할 예정이다.',
  originId: 't1', quote: input.texts[0].text };
const result = (items: object[]) => validatePropositionResult(input, { propositions: items });
// Hand-authored parser examples only, not real model outputs or quality scores.

test('provider input has exactly two opaque texts and refuses answer or role metadata', () => {
  const before = structuredClone(input), sent = propositionInput(input);
  assert.deepEqual(sent, input);
  sent.texts[0].text = 'changed copy';
  assert.deepEqual(input, before);
  assert.deepEqual(propositionInput({ texts: [...input.texts].reverse() }).texts.map((x: { id: string }) => x.id), ['t2', 't1']);
  for (const bad of [
    { ...input, required: ['answer'] }, { ...input, expected: 'answer' }, { ...input, caseId: 'E-03' },
    { texts: [{ ...input.texts[0], role: 'source' }, input.texts[1]] },
    { texts: [{ ...input.texts[0], required: 'answer' }, input.texts[1]] },
    { texts: [{ ...input.texts[0], id: 'source' }, input.texts[1]] },
    { texts: [input.texts[0], input.texts[0]] }, { texts: [input.texts[0]] },
    { texts: [...input.texts, input.texts[0]] }, { texts: [] },
    { texts: [{ id: 't1', text: ' ' }, input.texts[1]] },
    { texts: [{ id: 't1', text: '가'.repeat(2001) }, input.texts[1]] },
  ]) assert.throws(() => propositionInput(bad), /Only two bounded texts/);
});

test('flat response schema is detached and matches bounded strict output fields', () => {
  const schema = propositionResponseSchema(), before = JSON.stringify(schema);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['propositions']);
  assert.equal(schema.properties.propositions.minItems, 1);
  assert.equal(schema.properties.propositions.maxItems, 8);
  assert.deepEqual(schema.properties.propositions.items.required, ['id', 'statement', 'originId', 'quote']);
  assert.equal(schema.properties.propositions.items.additionalProperties, false);
  assert.equal(schema.properties.propositions.items.properties.statement.maxLength, 300);
  assert.equal(schema.properties.propositions.items.properties.quote.maxLength, 2000);
  assert.equal(/"(?:anyOf|oneOf)"/.test(before), false);
  schema.properties.propositions.items.properties.originId.enum.push('source');
  assert.equal(JSON.stringify(propositionResponseSchema()), before);
  for (const rule of ['사용자 속마음', '조건·부정·예정·가능성·수량·기한·한정', '한쪽에만', '명제를 작성하는 단계만']) {
    assert.ok(propositionInstruction.includes(rule));
  }
});

test('validation preserves each origin and rejects absent, stitched or normalized quotations', () => {
  const decoded = { propositions: [proposition, { id: 'h2', statement: '화요일까지 10명에게 안내한다.',
    originId: 't2', quote: input.texts[1].text }] };
  const before = structuredClone(decoded), checked = validatePropositionResult(input, decoded);
  assert.equal(checked.ok, true);
  checked.propositions[0].statement = 'changed copy';
  assert.deepEqual(decoded, before);
  for (const item of [
    { ...proposition, originId: 't2' }, { ...proposition, quote: '8명에게 안내합니다.' },
    { ...proposition, quote: '승인되면 8명에게' },
  ]) assert.equal(result([item]).validationError, 'quote-not-in-own-text');
  const unicodeInput = { texts: [{ id: 't1', text: '🙂 가\n나 é 가' }, { id: 't2', text: '별도 문장' }] };
  for (const quote of ['🙂 가\n나', 'é', '가']) {
    assert.equal(validatePropositionResult(unicodeInput, { propositions: [{ ...proposition, quote }] }).ok, true);
  }
  for (const quote of ['🙂 가 나', '가나', 'e\u0301', '가 ']) {
    assert.equal(validatePropositionResult(unicodeInput, { propositions: [{ ...proposition, quote }] }).validationError, 'quote-not-in-own-text');
  }
});

test('unknown fields, foreign IDs, duplicate IDs and exact duplicate statements fail closed', () => {
  for (const item of [
    { ...proposition, id: 'h9' }, { ...proposition, id: 'h0' }, { ...proposition, originId: 'candidate' },
    { ...proposition, expected: true }, { ...proposition, entailed: true }, { ...proposition, statement: '' },
    { ...proposition, statement: ' ' }, { ...proposition, quote: ' ' },
  ]) assert.equal(result([item]).validationError, 'proposition-schema');
  assert.equal(validatePropositionResult(input, { propositions: [proposition], explanation: 'answer' }).validationError, 'proposition-schema');
  assert.equal(result([proposition, { ...proposition, statement: '다른 명제' }]).validationError, 'duplicate-proposition-id');
  assert.equal(result([proposition, { ...proposition, id: 'h2' }]).validationError, 'duplicate-statement');
  assert.throws(() => validatePropositionResult({ ...input, expected: true }, { propositions: [proposition] }), /Only two bounded texts/);
});

test('limits count Unicode characters and do not silently truncate text or propositions', () => {
  const boundedInput = { texts: [{ id: 't1', text: '🙂'.repeat(2000) }, input.texts[1]] };
  assert.equal(propositionInput(boundedInput).texts[0].text, boundedInput.texts[0].text);
  const decoded = { propositions: [{ ...proposition, statement: '🙂'.repeat(300), quote: boundedInput.texts[0].text }] };
  assert.equal(validatePropositionResult(boundedInput, decoded).ok, true);
  assert.equal(result([{ ...proposition, statement: '🙂'.repeat(301) }]).validationError, 'proposition-schema');
  assert.equal(result([{ ...proposition, quote: '가'.repeat(2001) }]).validationError, 'proposition-schema');
  assert.equal(result([]).validationError, 'proposition-schema');
  const eight = Array.from({ length: 8 }, (_, index) => ({ ...proposition, id: `h${index + 1}`, statement: `명제 ${index + 1}` }));
  assert.equal(result(eight).ok, true);
  assert.equal(result([...eight, proposition]).validationError, 'proposition-schema');
});

test('valid shape and exact provenance never establish faithful meaning or complete coverage', () => {
  // The statement is deliberately unsupported by its exact quote. This validator
  // must not claim to detect the semantic error, nor infer coverage from a count.
  const checked = result([{ ...proposition, statement: '이미 모든 사람이 안내를 받았다.' }]);
  assert.equal(checked.ok, true);
  assert.equal(checked.semanticAssessment, 'not-performed');
  for (const key of ['qualityPassed', 'faithful', 'complete', 'equivalent', 'entailed']) assert.equal(Object.hasOwn(checked, key), false);
  assert.equal(result([{ ...proposition, id: 'h8' }]).ok, true);
});
