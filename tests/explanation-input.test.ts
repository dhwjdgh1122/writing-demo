import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExplanationInput, MAX_EXPLANATION_EDITS } from '../server/llm/explanation-input.js';

const compare = (source: string, candidate: string) => buildExplanationInput(source, [{ id: 'c1', text: candidate }]).candidates[0].comparison;

test('explanation input separates actual spacing and typo edits without repairing source quotations', () => {
  const result = compare('안내할수 잇습니다.', '안내할 수 있습니다.');
  assert.equal(result.mode, 'edits');
  assert.deepEqual(result.edits.map(e => [e.before, e.after, e.changeType]), [
    ['', ' ', 'spacing-only'], ['잇', '있', 'text-change'],
  ]);
  assert.ok(result.edits.every(e => e.sourceContext === '안내할수 잇습니다.' && e.candidateContext === '안내할 수 있습니다.'));
});

test('edit offsets reconstruct both strings across additions, deletions, repetition and Unicode', () => {
  const cases = [['', '추가'], ['삭제', ''], ['가\r\n나😀', '가 나😊'], ['가가가', '가가'], ['승인되면 5명에게 안내할수 잇습니다.', '5명에게 안내합니다.']];
  let seed = 37;
  const sample = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ['가', '나', ' ', '\n', '😀', '1', '́'][seed % 7]; };
  for (let i = 0; i < 80; i++) cases.push([Array.from({ length: 20 }, sample).join(''), Array.from({ length: 20 }, sample).join('')]);
  for (const [source, candidate] of cases) {
    const result = compare(source, candidate);
    assert.equal(result.mode, 'edits');
    let sourceEnd = 0, candidateEnd = 0, rebuilt = '';
    for (const edit of result.edits) {
      assert.equal(source.slice(edit.sourceStart, edit.sourceStart + edit.before.length), edit.before);
      assert.equal(candidate.slice(edit.candidateStart, edit.candidateStart + edit.after.length), edit.after);
      assert.equal(source.slice(sourceEnd, edit.sourceStart), candidate.slice(candidateEnd, edit.candidateStart));
      assert.ok(source.includes(edit.sourceContext)); assert.ok(candidate.includes(edit.candidateContext));
      rebuilt += source.slice(sourceEnd, edit.sourceStart) + edit.after;
      sourceEnd = edit.sourceStart + edit.before.length; candidateEnd = edit.candidateStart + edit.after.length;
    }
    assert.equal(rebuilt + source.slice(sourceEnd), candidate);
  }
});

test('candidate comparisons are independent, preserve IDs and never mutate source/candidates', () => {
  const source = '결재하지 않앗습니다.';
  const candidates = Object.freeze([
    Object.freeze({ id: 'word', text: '결제하지 않았습니다.' }),
    Object.freeze({ id: 'typo', text: '결재하지 않았습니다.' }),
    Object.freeze({ id: 'same', text: source }),
  ]);
  const result = buildExplanationInput(source, [...candidates]);
  assert.equal(result.sourceText, source);
  assert.deepEqual(result.candidates.map(({ id, text }) => ({ id, text })), candidates);
  assert.deepEqual(result.candidates[0].comparison.edits.map(e => [e.before, e.after]), [['재', '제'], ['앗', '았']]);
  assert.deepEqual(result.candidates[1].comparison.edits.map(e => [e.before, e.after]), [['앗', '았']]);
  assert.deepEqual(result.candidates[2].comparison, { mode: 'edits', edits: [] });
});

test('excessive edit count explicitly falls back to full text, never a misleading partial list', () => {
  const make = (count: number) => ['가X'.repeat(count), '가Y'.repeat(count)] as const;
  const atLimit = compare(...make(MAX_EXPLANATION_EDITS));
  assert.equal(atLimit.mode, 'edits'); assert.equal(atLimit.edits.length, MAX_EXPLANATION_EDITS);
  const [source, candidate] = make(MAX_EXPLANATION_EDITS + 1);
  const result = buildExplanationInput(source, [{ id: 'many', text: candidate }]);
  assert.deepEqual(result.candidates[0].comparison, { mode: 'whole-text', edits: [] });
  assert.equal(result.sourceText, source); assert.equal(result.candidates[0].text, candidate);
});

test('context preserves emoji boundaries and input comparison limits still apply', () => {
  const source = '😀'.repeat(15) + '가' + '😊'.repeat(15);
  const candidate = '😀'.repeat(15) + '나' + '😊'.repeat(15);
  const edit = compare(source, candidate).edits[0];
  assert.equal(edit.sourceStart, 30); assert.equal(edit.candidateStart, 30);
  assert.equal(edit.sourceContext, '😀'.repeat(12) + '가' + '😊'.repeat(12));
  assert.equal(edit.candidateContext, '😀'.repeat(12) + '나' + '😊'.repeat(12));
  assert.throws(() => compare('가'.repeat(1001), '나'), /limit/);
  assert.throws(() => compare('가', '나'.repeat(2001)), /limit/);
  assert.equal(compare('😀'.repeat(1000), '😊'.repeat(2000)).mode, 'edits');
});
