import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { candidatesWithExplanationChanges, explanationChangesMatch, getExplanationChanges } from '../shared/explanation-changes.js';
import { diffExpressions } from '../shared/expression-diff.js';
import { explanationsSchema, type Candidate, type ChangeExplanation } from '../shared/contracts.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';
import { createApp } from '../server/app.js';
import type { CorrectionProvider } from '../server/llm/provider.js';

test('expression groups preserve exact Unicode, repeated strings, whitespace and both offset domains', () => {
  for (const [source, candidate] of [
    ['안녕 하세요. 다음주 목요일', '안녕하세요. 다음 주 목요일'],
    ['전 빨리 중 빨리 후', '전 천천히 중 천천히 후'],
    ['자료 전송', '자료 즉시 전송'], ['자료 즉시 전송', '자료 전송'],
    ['  자료\n\n전송\t', ' 자료\r\n전송 '], [' ', '\n'], ['', '추가'], ['삭제', ''],
    ['😀 앞  글 뒤 🌊', '😀 앞 글 뒤 🌊'], ['그대로\n', '그대로\n'],
  ]) {
    const changes = getExplanationChanges(source, candidate);
    const parts = diffExpressions(source, candidate);
    assert.equal(parts.filter(part => part.kind !== 'add').map(part => part.text).join(''), source);
    assert.equal(parts.filter(part => part.kind !== 'remove').map(part => part.text).join(''), candidate);
    let sourceEnd = 0, candidateEnd = 0, reconstructed = '';
    for (const change of changes) {
      assert.equal(source.slice(change.sourceStart, change.sourceEnd), change.sourceText);
      assert.equal(candidate.slice(change.candidateStart, change.candidateEnd), change.candidateText);
      assert.equal(source.slice(sourceEnd, change.sourceStart), candidate.slice(candidateEnd, change.candidateStart));
      reconstructed += source.slice(sourceEnd, change.sourceStart) + change.candidateText;
      sourceEnd = change.sourceEnd;
      candidateEnd = change.candidateEnd;
    }
    assert.equal(source.slice(sourceEnd), candidate.slice(candidateEnd));
    assert.equal(reconstructed + source.slice(sourceEnd), candidate);
    assert.equal(new Set(changes.map(change => change.id)).size, changes.length);
    assert.deepEqual(getExplanationChanges(source, candidate), changes);
  }
});

test('IDs identify repeated occurrences and invalidate selections from an edited comparison', () => {
  const source = '전 빨리 중 빨리 후', candidate = '전 천천히 중 천천히 후';
  const changes = getExplanationChanges(source, candidate);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].sourceText, changes[1].sourceText);
  assert.notEqual(changes[0].id, changes[1].id);
  assert.ok(getExplanationChanges(source, candidate + '.').every(change => !changes.some(old => old.id === change.id)));
  assert.equal(getExplanationChanges('😀 앞  글', '😀 앞 글')[0].sourceStart, 3); // UTF-16, not code points.
  assert.ok(getExplanationChanges('자료 전송', '자료 즉시 전송').some(change => change.sourceText === ''));
  assert.ok(getExplanationChanges('자료 즉시 전송', '자료 전송').some(change => change.candidateText === ''));
  assert.throws(() => getExplanationChanges('가'.repeat(1001), '후보'), /limit/);
});

const sourceText = '목요일 자료를 보내 주세요.';
const candidates = [{ id: 'date', text: '이후 자료를 전달해 주세요.' }, { id: 'same', text: sourceText }];
const reasons = (candidate: Candidate): ChangeExplanation[] => getExplanationChanges(sourceText, candidate.text)
  .map(change => ({ changeId: change.id, title: '표현 변화', explanation: '해당 표현이 바뀌었습니다.' }));

test('link matching requires complete unique IDs but never relies on output order', () => {
  const good = reasons(candidates[0]);
  assert.equal(good.length, 2);
  assert.equal(explanationChangesMatch(sourceText, candidates[0].text, [...good].reverse()), true);
  for (const invalid of [[], good.slice(0, 1), [good[0], good[0]], [{ ...good[0], changeId: 'foreign' }, good[1]]]) {
    assert.equal(explanationChangesMatch(sourceText, candidates[0].text, invalid), false);
  }
  assert.equal(explanationsSchema.safeParse([{ candidateId: 'date', explanation: '과거 전체 설명' }]).success, true);
});

for (const name of ['gemini', 'elice'] as const) {
  const config = { apiKey: 'test-only-key', model: name === 'gemini' ? 'gemini-test' : 'gpt-4o-mini', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' };
  const wrap = (value: unknown) => name === 'gemini'
    ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] }
    : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] };
  const provider = (fetcher: typeof fetch) => name === 'gemini' ? createGeminiProvider(config, fetcher) : createEliceProvider(config, fetcher);

  test(`${name}: one existing explanation call sends exact groups and accepts reversed reason order`, async () => {
    let calls = 0;
    const changed = { candidateId: 'date', explanation: '날짜와 전달 표현이 바뀌었습니다.', changes: reasons(candidates[0]).reverse() };
    const instance = provider(async (_url, options) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      const sent = JSON.parse(name === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content);
      assert.deepEqual(sent, { sourceText, candidates: candidatesWithExplanationChanges(sourceText, candidates) });
      if (name === 'elice') assert.equal(body.max_tokens, 2000);
      const instruction = name === 'gemini' ? body.systemInstruction.parts[0].text : body.messages[0].content;
      assert.match(instruction, /changes 필드 전체를 생략/);
      return Response.json(wrap({ explanations: [changed, { candidateId: 'same', explanation: '더 좋음', changes: [] }] }));
    });
    assert.deepEqual(await instance.generateExplanations!(sourceText, candidates, new AbortController().signal), [
      changed, { candidateId: 'same', explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.', changes: [] },
    ]);
    assert.equal(calls, 1);
  });

  test(`${name}: supplied partial, duplicate, unknown, extra and malformed links fail only their candidate`, async () => {
    const good = reasons(candidates[0]);
    for (const changes of [[], good.slice(0, 1), [good[0], good[0]],
      [{ ...good[0], changeId: 'foreign' }, good[1]], [...good, { ...good[0], changeId: 'extra' }],
      [{ ...good[0], title: '' }, good[1]], [{ ...good[0], explanation: '가'.repeat(201) }, good[1]],
      [{ ...good[0], sourceText: '모델이 임의로 덧붙인 인용' }, good[1]], null]) {
      let calls = 0;
      const instance = provider(async () => {
        calls++;
        return Response.json(wrap({ explanations: [
          { candidateId: 'date', explanation: '전체 요약', changes },
          { candidateId: 'same', explanation: '변경 없음', changes: [] },
        ] }));
      });
      assert.deepEqual(await instance.generateExplanations!(sourceText, candidates, new AbortController().signal), [
        { candidateId: 'date', error: 'EXPLANATION_INVALID' },
        { candidateId: 'same', explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.', changes: [] },
      ]);
      assert.equal(calls, 1);
    }
  });

  test(`${name}: omitted links stay an explicit whole explanation without generated phrase reasons`, async () => {
    const legacy = { candidateId: 'date', explanation: '날짜 표현을 확인해주세요.' };
    const instance = provider(async () => Response.json(wrap({ explanations: [legacy] })));
    assert.deepEqual(await instance.generateExplanations!(sourceText, [candidates[0]], new AbortController().signal), [legacy]);
  });
}

async function setup(t: TestContext, provider: CorrectionProvider) {
  const server = createApp(provider).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return (input: unknown) => fetch(`http://127.0.0.1:${address.port}/api/explanations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

test('HTTP boundary rechecks custom provider links and nested quotations without blocking other candidates', async t => {
  const bad = { id: 'bad', text: '일요일 자료를 보내 주세요.' };
  let badChanges = reasons(bad);
  let calls = 0;
  const post = await setup(t, { configured: true, async generateCandidates() { throw new Error('No correction call'); },
    async generateExplanations() {
      calls++;
      return [
        { candidateId: 'date', explanation: '날짜가 달라졌습니다.', changes: reasons(candidates[0]) },
        { candidateId: bad.id, explanation: '날짜가 달라졌습니다.', changes: badChanges },
      ];
    },
  });
  const input = { requestId: 'linked-http', sourceText, candidates: [candidates[0], bad] };
  for (const changes of [reasons(candidates[0]), [], [{ ...reasons(bad)[0], changeId: 'foreign' }]]) {
    badChanges = changes;
    const response = await post(input);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.candidates, input.candidates);
    assert.deepEqual(body.explanations[0].changes, reasons(candidates[0]));
    assert.deepEqual(body.explanations[1], { candidateId: bad.id, error: 'EXPLANATION_INVALID' });
  }
  for (const field of ['title', 'explanation', 'caution'] as const) {
    badChanges = [{ ...reasons(bad)[0], [field]: '‘입력에없는표현’을 변경했습니다.' }];
    const response = await post(input);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.explanations[1], { candidateId: bad.id, error: 'EXPLANATION_QUOTE_MISMATCH' });
    assert.ok(!JSON.stringify(body).includes('입력에없는표현'));
  }
  assert.equal(calls, 6);
});
