import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { editorReducer as reduce, initialState, type EditorState } from '../client/src/state/editor.js';
import { diffText } from '../client/src/lib/diff.js';
import { diffExpressions } from '../client/src/lib/expression-diff.js';
import { countCharacters, correctionInputSchema, LIMITS, type RetryContext } from '../shared/contracts.js';
import { requestCorrection, requestExplanations, requestFailureCode } from '../client/src/lib/api.js';

function selected(text = '앞 문장. 같은 문장. 뒤 문장. 같은 문장.', start = 19, end = 25) {
  return reduce(reduce(initialState, { type: 'edit', text }), { type: 'select', start, end });
}
function result(state: EditorState, text: string, requestId = 'r1') {
  return reduce(reduce(state, { type: 'start', requestId }), { type: 'success', value: { requestId, sourceText: state.selection!.text, candidates: [{ id: 'c1', text }] } });
}
function stubFetch(t: TestContext, implementation: typeof fetch) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: implementation });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
    else Reflect.deleteProperty(globalThis, 'fetch');
  });
}
const jsonResponse = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => JSON.parse(JSON.stringify(body)) } as Response);
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

test('before-apply rerun keeps selected original and links the exact predecessor candidates', () => {
  const text = '앞 문장. 오늘 8명에게 보냅니다. 뒤 문장.';
  const source = '오늘 8명에게 보냅니다.';
  const start = text.indexOf(source);
  let state = result(selected(text, start, start + source.length), '오늘 8명에게 보내드립니다.');
  const original = state.result!.value;
  state = reduce(state, { type: 'start', requestId: 'r2', requirement: 'alternative' });
  assert.equal(state.pending?.sourceText, source);
  assert.equal(state.pending?.parentRequestId, 'r1');
  assert.equal(state.pending?.phase, 'before_apply');
  assert.deepEqual(state.pending?.retryContext, { requirement: 'alternative', previousSourceText: source, previousCandidates: original.candidates });
  assert.equal(state.pending?.retryContext?.previousSourceText.includes('뒤 문장'), false);
  assert.equal(reduce(state, { type: 'start', requestId: 'duplicate', requirement: 'plain' }), state);
});

test('after-apply rerun uses current applied selection while retaining its original context', () => {
  const source = '오늘 8명에게 보냅니다.';
  const candidate = '오늘 8명에게 보내드립니다.';
  let state = result(selected(`앞 ${source} 뒤`, 2, 2 + source.length), candidate);
  const previousCandidates = state.result!.value.candidates;
  state = reduce(state, { type: 'apply', candidateId: 'c1' });
  state = reduce(state, { type: 'start', requestId: 'r2', requirement: 'meaning' });
  assert.equal(state.pending?.sourceText, candidate);
  assert.equal(state.pending?.phase, 'after_apply');
  assert.equal(state.pending?.parentRequestId, 'r1');
  assert.deepEqual(state.pending?.retryContext, { requirement: 'meaning', previousSourceText: source, previousCandidates });
});

test('skipping requirement keeps the local link but omits model context', () => {
  let state = result(selected('원문', 0, 2), '바꾼 문장');
  state = reduce(state, { type: 'start', requestId: 'r2' });
  assert.equal(state.pending?.parentRequestId, 'r1');
  assert.equal(state.pending?.phase, 'before_apply');
  assert.equal(Object.hasOwn(state.pending!, 'retryContext'), false);
  state = reduce(state, { type: 'success', value: { requestId: 'r2', sourceText: '원문', candidates: [{ id: 'c2', text: '다른 문장' }] } });
  assert.equal(state.rerun?.parentRequestId, 'r2');
  assert.equal(state.result?.snapshot.parentRequestId, 'r1');
});

test('real edits, new selections and clearing invalidate rerun; no-op and caret events do not', () => {
  const state = result(selected('원문 다른 문장', 0, 2), '후보');
  assert.equal(reduce(state, { type: 'edit', text: state.text }), state);
  assert.equal(reduce(state, { type: 'select', start: 0, end: 2 }), state);
  assert.equal(reduce(state, { type: 'select', start: 1, end: 1 }), state);
  for (const next of [reduce(state, { type: 'edit', text: state.text + '!' }),
    reduce(state, { type: 'select', start: 3, end: 5 }), reduce(state, { type: 'clear' })]) {
    assert.equal(next.rerun, null);
    assert.equal(next.result, null);
  }
  const applied = reduce(state, { type: 'apply', candidateId: 'c1' });
  assert.equal(reduce(applied, { type: 'edit', text: state.text }).rerun, null, 'Undo is a real edit');
});

test('failed rerun retains predecessor and ignores old results after a new retry', () => {
  let state = result(selected('원문', 0, 2), '후보');
  const predecessor = state.rerun;
  state = reduce(state, { type: 'start', requestId: 'r2', requirement: 'polite' });
  const context = state.pending!.retryContext;
  state = reduce(state, { type: 'failure', requestId: 'r2', message: '다시 시도', errorCode: 'MODEL_TIMEOUT' });
  assert.equal(state.rerun, predecessor);
  state = reduce(state, { type: 'start', requestId: 'r3', requirement: 'plain' });
  const expected = state;
  assert.equal(reduce(state, { type: 'success', value: { requestId: 'r2', sourceText: '원문', retryContext: context, candidates: [{ id: 'old', text: '늦은 결과' }] } }), expected);
  assert.equal(reduce(state, { type: 'failure', requestId: 'r2', message: '늦은 오류' }), expected);
  assert.equal(state.pending?.parentRequestId, 'r1');
  assert.equal(state.pending?.retryContext?.requirement, 'plain');
});

test('explicit rerun retains the previous batch through loading and failure, then replaces it on valid success', () => {
  const original = result(selected('원문', 0, 2), '기존 후보');
  let state = reduce(original, { type: 'startRerun', requestId: 'r2', requirement: 'polite' });
  assert.equal(state.result, original.result, 'preserve the exact batch so its comparison and explanation state stays mounted');
  assert.equal(state.rerun, original.rerun);
  assert.equal(state.pending?.sourceText, '원문');
  assert.equal(state.pending?.retryContext?.requirement, 'polite');
  assert.equal(reduce(state, { type: 'apply', candidateId: 'c1' }), state, 'old candidates cannot be applied during a rerun');
  assert.equal(reduce(state, { type: 'startRerun', requestId: 'duplicate', requirement: 'plain' }), state);
  assert.equal(reduce(state, { type: 'start', requestId: 'ordinary-duplicate' }), state);

  state = reduce(state, { type: 'failure', requestId: 'r2', message: '잠시 후 다시 시도해주세요.', errorCode: 'MODEL_TIMEOUT' });
  assert.equal(state.pending, null);
  assert.equal(state.result, original.result);
  assert.equal(state.rerun, original.rerun, 'a failed attempt never becomes the next parent');
  assert.equal(state.text, original.text);
  assert.equal(reduce(state, { type: 'apply', candidateId: 'c1' }).selection?.text, '기존 후보', 'retained candidates remain usable after failure');

  state = reduce(state, { type: 'startRerun', requestId: 'r3', requirement: 'polite' });
  assert.equal(state.error, null);
  assert.equal(state.pending?.parentRequestId, 'r1');
  assert.deepEqual(state.pending?.retryContext?.previousCandidates, original.result!.value.candidates);
  const pending = state.pending!;
  state = reduce(state, { type: 'success', value: { requestId: 'r3', sourceText: '원문',
    retryContext: pending.retryContext, candidates: [{ id: 'new', text: '새 후보' }] } });
  assert.notEqual(state.result, original.result);
  assert.equal(state.result?.snapshot, pending);
  assert.equal(state.result?.value.candidates[0].text, '새 후보');
  assert.equal(state.result?.snapshot.retryContext?.requirement, 'polite', 'executed requirement remains attached to its successful result');
  assert.equal(state.rerun?.parentRequestId, 'r3');
  assert.equal(state.error, null);
});

test('an invalid rerun response keeps the last valid batch and parent for the next retry', () => {
  const original = result(selected('원문', 0, 2), '기존 후보');
  const pending = reduce(original, { type: 'startRerun', requestId: 'r2', requirement: 'meaning' });
  for (const change of [{ sourceText: '다른 원문', retryContext: pending.pending!.retryContext },
    { sourceText: '원문', retryContext: undefined },
    { sourceText: '원문', retryContext: { ...pending.pending!.retryContext!, requirement: 'plain' as const } }]) {
    const rejected = reduce(pending, { type: 'success', value: { requestId: 'r2', ...change, candidates: [{ id: 'bad', text: '잘못 연결된 후보' }] } });
    assert.equal(rejected.pending, null);
    assert.equal(rejected.result, original.result);
    assert.equal(rejected.rerun, original.rerun);
    assert.ok(rejected.error);
    const retry = reduce(rejected, { type: 'startRerun', requestId: 'r3', requirement: 'meaning' });
    assert.equal(retry.pending?.parentRequestId, 'r1');
    assert.equal(retry.pending?.retryContext?.previousCandidates, original.result!.value.candidates);
  }
});

test('after-apply rerun preserves the applied notice and current text until a valid result arrives', () => {
  const original = result(selected('원문', 0, 2), '적용한 문장');
  const applied = reduce(original, { type: 'apply', candidateId: 'c1' });
  let state = reduce(applied, { type: 'startRerun', requestId: 'r2', requirement: 'alternative' });
  assert.equal(state.notice, applied.notice);
  assert.equal(state.result, null);
  assert.equal(state.text, '적용한 문장');
  assert.equal(state.pending?.sourceText, '적용한 문장');
  assert.equal(state.pending?.phase, 'after_apply');
  assert.equal(state.pending?.retryContext?.previousSourceText, '원문');
  state = reduce(state, { type: 'failure', requestId: 'r2', message: '실패' });
  assert.equal(state.notice, applied.notice);
  assert.equal(state.rerun, applied.rerun);
  assert.equal(state.selection, applied.selection);
  state = reduce(state, { type: 'startRerun', requestId: 'r3', requirement: 'alternative' });
  const pending = state.pending!;
  state = reduce(state, { type: 'success', value: { requestId: 'r3', sourceText: pending.sourceText,
    retryContext: pending.retryContext, candidates: [{ id: 'new', text: '다시 만든 문장' }] } });
  assert.equal(state.notice, null, 'new results replace the applied-state view');
  assert.equal(state.text, '적용한 문장', 'receiving a rerun result never edits the current document');
  assert.equal(state.result?.snapshot.phase, 'after_apply');
  assert.equal(state.result?.snapshot.parentRequestId, 'r1');
  assert.equal(state.rerun?.phase, 'before_apply');
});

test('plain rerun preserves results without adding demand context; ordinary correction still clears its view', () => {
  const original = result(selected('원문', 0, 2), '후보');
  const rerun = reduce(original, { type: 'startRerun', requestId: 'r2' });
  assert.equal(rerun.result, original.result);
  assert.equal(rerun.pending?.parentRequestId, 'r1');
  assert.equal(Object.hasOwn(rerun.pending!, 'retryContext'), false);
  const ordinary = reduce(original, { type: 'start', requestId: 'r2' });
  assert.equal(ordinary.result, null);
  assert.equal(ordinary.notice, null);
  const applied = reduce(original, { type: 'apply', candidateId: 'c1' });
  assert.equal(reduce(applied, { type: 'start', requestId: 'r2' }).notice, null);
  const noPredecessor = selected('원문', 0, 2);
  assert.equal(reduce(noPredecessor, { type: 'startRerun', requestId: 'r2' }), noPredecessor);
  assert.equal(reduce(noPredecessor, { type: 'startRerun', requestId: 'r2', requirement: 'polite' }), noPredecessor);
});

test('edits, new selections and clear take priority over retained rerun output and late responses', () => {
  const pending = reduce(result(selected('원문 다른 문장', 0, 2), '기존 후보'), { type: 'startRerun', requestId: 'r2', requirement: 'errors' });
  const lateResult = { requestId: 'r2', sourceText: '원문', retryContext: pending.pending!.retryContext, candidates: [{ id: 'late', text: '늦은 후보' }] };
  for (const invalidated of [reduce(pending, { type: 'edit', text: '편집한 원문' }),
    reduce(pending, { type: 'select', start: 3, end: 5 }), reduce(pending, { type: 'clear' })]) {
    assert.equal(invalidated.pending, null);
    assert.equal(invalidated.result, null);
    assert.equal(invalidated.rerun, null);
    assert.equal(reduce(invalidated, { type: 'success', value: lateResult }), invalidated);
    assert.equal(reduce(invalidated, { type: 'failure', requestId: 'r2', message: '늦은 실패' }), invalidated);
  }
  const failed = reduce(pending, { type: 'failure', requestId: 'r2', message: '실패' });
  const retry = reduce(failed, { type: 'startRerun', requestId: 'r3', requirement: 'errors' });
  assert.equal(reduce(retry, { type: 'success', value: lateResult }), retry);
  assert.equal(reduce(retry, { type: 'failure', requestId: 'r2', message: '늦은 실패' }), retry);
  assert.equal(retry.result, pending.result);
});

test('matching request and source cannot accept a changed or missing rerun context', () => {
  const state = reduce(result(selected('원문', 0, 2), '후보'), { type: 'start', requestId: 'r2', requirement: 'errors' });
  const context = state.pending!.retryContext!;
  for (const retryContext of [undefined, { ...context, requirement: 'polite' as const },
    { ...context, previousSourceText: '다른 원문' }, { ...context, previousCandidates: [{ id: 'c1', text: '다른 후보' }] }]) {
    const next = reduce(state, { type: 'success', value: { requestId: 'r2', sourceText: '원문', candidates: [{ id: 'c2', text: '새 후보' }], retryContext } });
    assert.equal(next.result, null);
    assert.equal(next.pending, null);
    assert.ok(next.error);
    assert.equal(next.rerun, state.rerun);
  }
  const accepted = reduce(state, { type: 'success', value: { requestId: 'r2', sourceText: '원문', candidates: [{ id: 'c2', text: '새 후보' }], retryContext: context } });
  assert.equal(accepted.result?.value.requestId, 'r2');
  assert.equal(accepted.rerun?.previousSourceText, '원문');
  assert.deepEqual(accepted.rerun?.previousCandidates, [{ id: 'c2', text: '새 후보' }]);
});

test('new selections cannot attach a requirement without a predecessor', () => {
  const state = selected('원문', 0, 2);
  assert.equal(reduce(state, { type: 'start', requestId: 'r1', requirement: 'polite' }), state);
  const ordinary = reduce(state, { type: 'start', requestId: 'r1' });
  assert.equal(Object.hasOwn(ordinary.pending!, 'parentRequestId'), false);
  assert.equal(Object.hasOwn(ordinary.pending!, 'retryContext'), false);
});

test('an applied candidate over the selection limit cannot be rerun until a new range is selected', () => {
  const applied = reduce(result(selected('원문', 0, 2), '가'.repeat(1001)), { type: 'apply', candidateId: 'c1' });
  assert.equal(applied.rerun?.phase, 'after_apply');
  assert.equal(reduce(applied, { type: 'start', requestId: 'r2', requirement: 'plain' }), applied);
  const smaller = reduce(applied, { type: 'select', start: 0, end: 1000 });
  assert.equal(smaller.rerun, null);
  assert.ok(reduce(smaller, { type: 'start', requestId: 'r2' }).pending);
});

test('client accepts ordinary responses and exact rerun echoes but rejects altered context', async t => {
  const context: RetryContext = { requirement: 'alternative', previousSourceText: '이전 원문', previousCandidates: [{ id: 'prior', text: '이전 후보' }] };
  let payload: unknown;
  let body: Record<string, unknown> = { requestId: 'r1', sourceText: '원문', candidates: [{ id: 'c1', text: '후보' }] };
  stubFetch(t, async (_url, init) => {
    payload = JSON.parse(init!.body as string);
    return jsonResponse(body);
  });
  const signal = new AbortController().signal;
  assert.equal((await requestCorrection({ requestId: 'r1', sourceText: '원문' }, signal)).requestId, 'r1');
  assert.deepEqual(payload, { requestId: 'r1', sourceText: '원문' });
  body = { ...body, retryContext: context };
  assert.deepEqual((await requestCorrection({ requestId: 'r1', sourceText: '원문', retryContext: context }, signal)).retryContext, context);
  for (const changed of [undefined, { ...context, requirement: 'polite' }, { ...context, previousCandidates: [{ id: 'other', text: '이전 후보' }] }]) {
    body = { ...body, retryContext: changed };
    await assert.rejects(requestCorrection({ requestId: 'r1', sourceText: '원문', retryContext: context }, signal), error => requestFailureCode(error) === 'CLIENT_RESPONSE_INVALID');
  }
});

test('client explanation requests carry the current candidates and demand context with exact response matching', async t => {
  const retryContext: RetryContext = { requirement: 'meaning', previousSourceText: '원래 8명', previousCandidates: [{ id: 'previous', text: '현재 10명' }] };
  const input = { requestId: 'e1', sourceText: '현재 10명', candidates: [{ id: 'c2', text: '다시 8명' }], retryContext };
  const explanations = [{ candidateId: 'c2', error: 'EXPLANATION_INVALID' as const }];
  let changed = false;
  stubFetch(t, async (_url, init) => {
    assert.deepEqual(JSON.parse(init!.body as string), input);
    return jsonResponse({ ...input, explanations, retryContext: changed ? { ...retryContext, previousSourceText: '다른 의도' } : retryContext });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await requestExplanations(input, signal), explanations);
  changed = true;
  await assert.rejects(requestExplanations(input, signal), error => requestFailureCode(error) === 'CLIENT_RESPONSE_INVALID');
});

test('client failure codes never copy arbitrary server errors or network messages into activity metadata', async t => {
  let code = 'MODEL_OUTPUT_TRUNCATED';
  stubFetch(t, async () => jsonResponse({ error: { code, message: 'private sentence and url' } }, 503));
  const input = { requestId: 'r1', sourceText: '원문' };
  const signal = new AbortController().signal;
  await assert.rejects(requestCorrection(input, signal), error => requestFailureCode(error) === 'MODEL_OUTPUT_TRUNCATED');
  code = 'private server details';
  await assert.rejects(requestCorrection(input, signal), error => requestFailureCode(error) === 'CLIENT_REQUEST_FAILED');
  assert.equal(requestFailureCode(new Error('private network URL')), 'CLIENT_REQUEST_FAILED');
});
for (const [source, candidate] of [['목요일에 안내', '이후에 안내'], ['남아 있다', '남아있다'], ['가\n나😀', '가 나😊'], ['같음', '같음'], ['삭제만', '삭제']]) {
  test(`diff reconstructs both strings without changing content: ${JSON.stringify(source)}`, () => {
    const parts = diffText(source, candidate);
    assert.equal(parts.filter(p => p.kind !== 'add').map(p => p.text).join(''), source);
    assert.equal(parts.filter(p => p.kind !== 'remove').map(p => p.text).join(''), candidate);
    if (source === candidate) assert.ok(parts.every(p => p.kind === 'same'));
  });
}

function assertExpressionReconstruction(source: string, candidate: string) {
  const parts = diffExpressions(source, candidate);
  assert.equal(parts.filter(p => p.kind !== 'add').map(p => p.text).join(''), source);
  assert.equal(parts.filter(p => p.kind !== 'remove').map(p => p.text).join(''), candidate);
  return parts;
}

test('expression comparison highlights complete split or joined expressions without marking adjacent words', () => {
  for (const [before, after] of [['안녕 하세요', '안녕하세요'], ['다음주', '다음 주']]) {
    const parts = assertExpressionReconstruction(`앞 ${before} 목요일`, `앞 ${after} 목요일`);
    assert.deepEqual(parts.filter(p => p.kind === 'remove').map(p => p.text), [before]);
    assert.deepEqual(parts.filter(p => p.kind === 'add').map(p => p.text), [after]);
    assert.equal(parts.filter(p => p.kind === 'same').map(p => p.text).join(''), '앞  목요일');
  }
});

test('expression comparison keeps unchanged context plain while showing the whole replaced expression', () => {
  const parts = assertExpressionReconstruction('금요일까지 자료를 보내 주세여.', '금요일까지 자료를 보내 주세요.');
  assert.deepEqual(parts.filter(p => p.kind === 'remove').map(p => p.text), ['주세여.']);
  assert.deepEqual(parts.filter(p => p.kind === 'add').map(p => p.text), ['주세요.']);
  assert.equal(parts.filter(p => p.kind === 'same').map(p => p.text).join(''), '금요일까지 자료를 보내 ');
});

test('whitespace-only changes include readable word context and preserve the actual whitespace', () => {
  for (const [source, candidate] of [['오늘  공지', '오늘 공지'], ['오늘\n공지', '오늘 공지'], ['오늘\t공지', '오늘 공지']]) {
    const parts = assertExpressionReconstruction(source, candidate);
    const removed = parts.filter(p => p.kind === 'remove').map(p => p.text).join('');
    const added = parts.filter(p => p.kind === 'add').map(p => p.text).join('');
    assert.match(removed, /오늘|공지/, 'a removed gap needs readable surrounding expression context');
    assert.match(added, /오늘|공지/, 'the corresponding candidate expression must be visible too');
    assert.ok(removed.includes(source.slice('오늘'.length, -'공지'.length)));
    assert.ok(added.includes(' '));
  }
});

test('expression comparison preserves literal symbols, emoji, line endings and empty or repeated text', () => {
  const pairs = [
    ['· ↵ ⇥ 😀\r\n안녕 하세요', '· ↵ ⇥ 😊\r\n안녕하세요'],
    ['같은 문장 같은 문장 끝.', '같은 표현 같은 문장 끝.'],
    ['  오늘 공지\n', '\t오늘 공지\r\n'],
    [' \t\n', '  \r\n'],
    ['', '새 문장'], ['삭제할 문장', ''], ['', ''],
    ['그대로 · ↵ ⇥\r\n😀', '그대로 · ↵ ⇥\r\n😀'],
  ];
  for (const [source, candidate] of pairs) {
    const parts = assertExpressionReconstruction(source, candidate);
    assert.deepEqual(diffExpressions(source, candidate), parts, 'repeated words must have a stable comparison');
    if (source === candidate) assert.ok(parts.every(p => p.kind === 'same'));
  }
});

test('expression comparison enforces selection and candidate limits by code point', () => {
  assertExpressionReconstruction('😀'.repeat(LIMITS.selection), '😊'.repeat(LIMITS.candidate));
  assert.throws(() => diffExpressions('😀'.repeat(LIMITS.selection + 1), '후보'));
  assert.throws(() => diffExpressions('원문', '😊'.repeat(LIMITS.candidate + 1)));
});
