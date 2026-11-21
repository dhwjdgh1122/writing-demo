import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error Manual runner exports pure helpers; CLI execution is guarded.
import { buildIsolatedConditionPlan, isolatedConditionInput, validateIsolatedConditionResult } from '../scripts/evaluate-explanation-isolated-conditions.mjs';

const gate = JSON.parse(readFileSync(new URL('./fixtures/issue22-original-gate-2026-11-22.json', import.meta.url), 'utf8'));

test('fixed plan alternates arm order and isolates each text without counterpart, answers or source roles', () => {
  const before = JSON.stringify(gate);
  const plan = buildIsolatedConditionPlan(gate);
  assert.equal(plan.length, 9);
  assert.deepEqual(plan.map((entry: { label: string }) => entry.label), [
    'E-03-joint', 'E-03-isolated-t1', 'E-03-isolated-t2',
    'CT-02-isolated-t1', 'CT-02-isolated-t2', 'CT-02-joint',
    'CT-03-joint', 'CT-03-isolated-t1', 'CT-03-isolated-t2',
  ]);
  for (const id of ['E-03', 'CT-02', 'CT-03']) {
    const entries = plan.filter((entry: { caseId: string }) => entry.caseId === id);
    const joint = entries.find((entry: { arm: string }) => entry.arm === 'joint');
    const isolated = entries.filter((entry: { arm: string }) => entry.arm === 'isolated');
    assert.deepEqual(isolated.flatMap((entry: { input: { texts: unknown[] } }) => entry.input.texts), joint.input.texts);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry.input), ['texts']);
      for (const text of entry.input.texts) assert.deepEqual(Object.keys(text), ['id', 'text']);
      if (entry.arm === 'isolated') assert.equal(entry.input.texts.length, 1);
    }
    isolated[0].input.texts[0].text = 'mutated returned copy';
    assert.notEqual(joint.input.texts[0].text, 'mutated returned copy');
  }
  assert.equal(JSON.stringify(gate), before);
  const changed = structuredClone(gate); changed.cases.find((c: { id: string }) => c.id === 'E-03').sourceText += ' changed';
  assert.throws(() => buildIsolatedConditionPlan(changed), /Frozen gate/);
});

test('model input rejects extra metadata, roles, duplicate IDs and unexpected text counts without mutating valid inputs', () => {
  const good = { texts: [{ id: 't2', text: '출입할 수 없습니다.' }] };
  for (const bad of [
    { ...good, expected: 'none' }, { ...good, sourceText: 'hidden original' },
    { texts: [{ ...good.texts[0], required: ['answer'] }] }, { texts: [{ ...good.texts[0], role: 'candidate' }] },
    { texts: [{ id: 'source', text: 'original' }] }, { texts: [] }, { texts: [good.texts[0], good.texts[0]] },
    { texts: [{ id: 't1', text: ' ' }] }, { texts: [{ id: 't1', text: '가'.repeat(2001) }] },
  ]) assert.throws(() => isolatedConditionInput(bad), /Only bounded texts/);
  const copy = isolatedConditionInput(good); copy.texts[0].text = 'changed';
  assert.equal(good.texts[0].text, '출입할 수 없습니다.');
});

test('literal quote validation checks ownership while retaining negation and making no semantic verdict', () => {
  const input = { texts: [
    { id: 't1', text: '허가가 없으면 출입할 수 없습니다.' }, { id: 't2', text: '출입할 수 없습니다.' },
  ] };
  const raw = { items: [
    { id: 't2', conditions: [] },
    { id: 't1', conditions: [{ conditionQuote: '허가가 없으면', governedQuote: '출입할 수 없습니다.' }] },
  ] };
  const before = JSON.stringify({ input, raw });
  const result = validateIsolatedConditionResult(input, raw);
  assert.equal(result.ok, true);
  assert.equal(result.semanticAssessment, 'not-performed');
  assert.deepEqual(result.presence, [{ id: 't2', conditionPresence: 'none' }, { id: 't1', conditionPresence: 'one-or-more' }]);
  result.items[1].conditions[0].governedQuote = 'changed';
  assert.equal(JSON.stringify({ input, raw }), before);
  const wrongOwner = { items: [{ id: 't2', conditions: raw.items[1].conditions }] };
  assert.equal(validateIsolatedConditionResult({ texts: [input.texts[1]] }, wrongOwner).validationError, 'quote-not-in-own-text');
  const changedNegation = structuredClone(raw); changedNegation.items[1].conditions[0].governedQuote = '출입할 수 있습니다.';
  assert.equal(validateIsolatedConditionResult(input, changedNegation).validationError, 'quote-not-in-own-text');
  // Literal fragments can still omit important meaning. Structural validation
  // deliberately does not upgrade this to semantic correctness or equivalence.
  const insufficient = structuredClone(raw); insufficient.items[1].conditions[0].governedQuote = '출입';
  assert.equal(validateIsolatedConditionResult(input, insufficient).ok, true);
});

test('extraction response rejects missing/duplicate ownership, extra fields, oversized quotes and duplicate conditions', () => {
  const input = { texts: [{ id: 't1', text: '회원만 자료를 받을 수 있습니다.' }] };
  const condition = { conditionQuote: '회원만', governedQuote: '자료를 받을 수 있습니다.' };
  const item = { id: 't1', conditions: [condition] };
  for (const raw of [
    {}, { items: [] }, { items: [item], expected: 'preserved' },
    { items: [{ ...item, sameCondition: true }] }, { items: [{ ...item, conditions: [{ ...condition, meaning: 'answer' }] }] },
    { items: [{ ...item, conditions: [{ ...condition, governedQuote: '가'.repeat(301) }] }] },
    { items: [{ ...item, conditions: [{ ...condition, conditionQuote: '' }] }] },
    { items: [{ ...item, conditions: Array.from({ length: 6 }, () => condition) }] },
    { items: [item, item] }, { items: [{ ...item, id: 't2' }] },
    { items: [{ ...item, conditions: [condition, condition] }] },
  ]) assert.equal(validateIsolatedConditionResult(input, raw).ok, false);
  const both = { texts: [...input.texts, { id: 't2', text: input.texts[0].text }] };
  assert.equal(validateIsolatedConditionResult(both, { items: [item] }).validationError, 'text-ownership');
  const result = validateIsolatedConditionResult(both, { items: [item, { ...item, id: 't2' }] });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, 'sameCondition'), false);
});
