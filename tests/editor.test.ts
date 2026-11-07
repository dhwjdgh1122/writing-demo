import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorReducer as reduce, initialState, type EditorState } from '../client/src/state/editor.js';
import { diffText } from '../client/src/lib/diff.js';
import { countCharacters, correctionInputSchema } from '../shared/contracts.js';

function selected(text = '앞 문장. 같은 문장. 뒤 문장. 같은 문장.', start = 19, end = 25) {
  return reduce(reduce(initialState, { type: 'edit', text }), { type: 'select', start, end });
}
function result(state: EditorState, text: string, requestId = 'r1') {
  return reduce(reduce(state, { type: 'start', requestId }), { type: 'success', value: { requestId, sourceText: state.selection!.text, candidates: [{ id: 'c1', text }] } });
}
test('applies to the selected occurrence only and preserves surrounding text', () => {
  const text = '앞. 같은 문장. 중간. 같은 문장. 끝.';
  const start = text.lastIndexOf('같은 문장.');
  let state = selected(text, start, start + '같은 문장.'.length);
  state = result(state, '수정한 문장입니다.');
  state = reduce(state, { type: 'apply', candidateId: 'c1' });
  assert.equal(state.text, '앞. 같은 문장. 중간. 수정한 문장입니다. 끝.');
  assert.equal(state.selection?.text, '수정한 문장입니다.');
  assert.equal(state.result, null);
  assert.equal(reduce(state, { type: 'apply', candidateId: 'c1' }).text, state.text);
});
test('selection change invalidates results even for identical text at another position', () => {
  let state = result(selected('문장 문장', 0, 2), '새 문장');
  state = reduce(state, { type: 'select', start: 3, end: 5 });
  state = reduce(state, { type: 'apply', candidateId: 'c1' });
  assert.equal(state.text, '문장 문장');
  assert.equal(state.result, null);
});
test('late success and failure cannot overwrite a newer pending request', () => {
  let state = reduce(selected('첫째 둘째', 0, 2), { type: 'start', requestId: 'old' });
  state = reduce(state, { type: 'select', start: 3, end: 5 });
  state = reduce(state, { type: 'start', requestId: 'new' });
  const expected = state;
  state = reduce(state, { type: 'success', value: { requestId: 'old', sourceText: '첫째', candidates: [{ id: 'c1', text: '이전' }] } });
  state = reduce(state, { type: 'failure', requestId: 'old', message: 'old failure' });
  assert.equal(state, expected);
});
test('editing and then restoring the same document does not restore a pending request', () => {
  let state = reduce(selected('원문', 0, 2), { type: 'start', requestId: 'old' });
  state = reduce(state, { type: 'edit', text: '원문!' });
  state = reduce(state, { type: 'edit', text: '원문' });
  state = reduce(state, { type: 'select', start: 0, end: 2 });
  state = reduce(state, { type: 'success', value: { requestId: 'old', sourceText: '원문', candidates: [{ id: 'c1', text: '오래된 결과' }] } });
  assert.equal(state.result, null);
});
test('duplicate selection events and caret moves keep a valid result', () => {
  const state = result(selected('선택한 문장', 0, 6), '후보');
  assert.equal(reduce(state, { type: 'select', start: 0, end: 6 }), state);
  assert.equal(reduce(state, { type: 'select', start: 2, end: 2 }), state);
});
test('mismatched response source is rejected', () => {
  const state = reduce(selected('원문', 0, 2), { type: 'start', requestId: 'r1' });
  const next = reduce(state, { type: 'success', value: { requestId: 'r1', sourceText: '다른 원문', candidates: [{ id: 'c1', text: '후보' }] } });
  assert.equal(next.result, null);
  assert.ok(next.error);
});
test('UTF-16 positions and code point lengths do not corrupt emoji or whitespace', () => {
  let state = selected('앞😀 문장\n뒤', 1, 6);
  assert.equal(state.selection?.text, '😀 문장');
  assert.equal(countCharacters(state.selection!.text), 4);
  state = reduce(result(state, '😊 표현'), { type: 'apply', candidateId: 'c1' });
  assert.equal(state.text, '앞😊 표현\n뒤');
});
test('blank or oversized input cannot start, exactly 1000 code points can', () => {
  for (const text of ['  \n', '가'.repeat(1001)]) assert.equal(reduce(selected(text, 0, text.length), { type: 'start', requestId: 'r1' }).pending, null);
  const text = '😀'.repeat(1000);
  assert.ok(reduce(selected(text, 0, text.length), { type: 'start', requestId: 'r1' }).pending);
  assert.ok(correctionInputSchema.safeParse({ requestId: 'r1', sourceText: text }).success);
});
test('oversized documents remain visible but do not send a correction request', () => {
  let state = selected('가'.repeat(20001), 0, 10);
  state = reduce(state, { type: 'start', requestId: 'r1' });
  assert.equal(state.text.length, 20001);
  assert.equal(state.pending, null);
});
for (const [source, candidate] of [['목요일에 안내', '이후에 안내'], ['남아 있다', '남아있다'], ['가\n나😀', '가 나😊'], ['같음', '같음'], ['삭제만', '삭제']]) {
  test(`diff reconstructs both strings without changing content: ${JSON.stringify(source)}`, () => {
    const parts = diffText(source, candidate);
    assert.equal(parts.filter(p => p.kind !== 'add').map(p => p.text).join(''), source);
    assert.equal(parts.filter(p => p.kind !== 'remove').map(p => p.text).join(''), candidate);
    if (source === candidate) assert.ok(parts.every(p => p.kind === 'same'));
  });
}
