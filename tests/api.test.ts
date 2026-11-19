import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { ProviderError, type CorrectionProvider } from '../server/llm/provider.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';
import coverageCases from './fixtures/correction-coverage-cases.json';
import { renderExplanationResponse } from '../server/llm/explanation-response.js';

async function setup(t: TestContext, provider?: CorrectionProvider, timeoutMs?: number) {
  const server = createApp(provider, timeoutMs).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${address.port}`;
  return { base, post: (body: unknown) => fetch(`${base}/api/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}

for (const name of ['gemini', 'elice'] as const) {
  test(`${name}: space-only facts replace model speculation through HTTP without an extra call`, async t => {
    let calls = 0;
    const sourceText = '금요일까지 자료를 보내 주세요.';
    const candidates = [{ id: 'spacing', text: '금요일까지 자료를 보내주세요.' }, { id: 'date', text: '이후에 자료를 보내 주세요.' }];
    const fetcher: typeof fetch = async () => {
      calls++;
      const text = JSON.stringify({ explanations: [
        { candidateId: 'spacing', references: [], explanation: '공백을 추가해 비격식적인 어조로 바뀌었습니다.' },
        { candidateId: 'date', references: [{ before: '금요일까지', after: '이후에' }], explanation: '금요일이라는 기한이 불분명한 이후로 바뀌었습니다.' },
      ] });
      return Response.json(name === 'gemini'
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: text } }] });
    };
    const provider = name === 'gemini'
      ? createGeminiProvider({ apiKey: 'fake-test-key', model: 'gemini-test' }, fetcher)
      : createEliceProvider({ apiKey: 'fake-test-key', model: 'test-model', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' }, fetcher);
    const { base } = await setup(t, provider);
    const response = await fetch(`${base}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: `spacing-${name}`, sourceText, candidates }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.candidates, candidates);
    assert.equal(body.explanations[0].explanation, '공백 1개를 삭제했습니다. 원문 비교에서 단어가 나뉜 위치가 의도에 맞는지 확인해 주세요.');
    assert.match(body.explanations[1].explanation, /금요일이라는 기한/);
    assert.equal(calls, 1);
  });
}

test('HTTP guard preserves exact multiline evidence and rejects a fabricated multiline quote per candidate', async t => {
  const sourceText = '회의를\n시작합니다.';
  const candidates = [{ id: 'good', text: '회의를\n진행합니다.' }, { id: 'bad', text: '회의를\n엽니다.' }];
  const { base } = await setup(t, { configured: true, async generateCandidates() { return []; },
    async generateExplanations() {
      return [
        ...renderExplanationResponse(sourceText, [candidates[0]], { explanations: [{ candidateId: 'good',
          references: [{ before: sourceText, after: candidates[0].text }], explanation: '시작한다는 표현을 진행한다는 표현으로 바꿨습니다.' }] }),
        { candidateId: 'bad', explanation: '‘회의를\n종료합니다.’로 바뀌었습니다.' },
      ];
    },
  });
  const response = await fetch(`${base}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'multiline-guard', sourceText, candidates }) });
  assert.equal(response.status, 200);
  const result = (await response.json()).explanations;
  assert.match(result[0].explanation, /회의를\n진행합니다/);
  assert.deepEqual(result[1], { candidateId: 'bad', error: 'EXPLANATION_QUOTE_MISMATCH' });
});
test('without API, returns honest health state and 503 instead of fabricated candidates', async t => {
  const { base, post } = await setup(t);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: 'ok', modelConfigured: false });
  const response = await post({ requestId: 'r1', sourceText: '원문' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'MODEL_NOT_CONFIGURED');
});
test('rejects unselected context, blank inputs, and length violations before model calls', async t => {
  let calls = 0;
  const { post } = await setup(t, { configured: true, async generateCandidates() { calls++; return ['후보']; } });
  for (const body of [{ requestId: 'r1', sourceText: '원문', document: '주변 문맥' }, { requestId: 'r1', sourceText: ' \n' }, { requestId: 'r1', sourceText: '가'.repeat(1001) }]) assert.equal((await post(body)).status, 400);
  assert.equal(calls, 0);
});
test('test provider receives only exact source text; server supplies distinct candidate IDs', async t => {
  let received = '';
  const { post } = await setup(t, { configured: true, async generateCandidates(text) { received = text; return ['후보', '후보']; } });
  const response = await post({ requestId: 'r1', sourceText: ' 원문\n' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(received, ' 원문\n');
  assert.equal(body.sourceText, received);
  assert.equal(body.candidates.length, 2);
  assert.notEqual(body.candidates[0].id, body.candidates[1].id);
});
test('invalid model output and thrown provider errors preserve error contracts', async t => {
  for (const output of [[], [''], ['a','b','c','d'], ['가'.repeat(2001)], 'not-an-array']) {
    const { post } = await setup(t, { configured: true, async generateCandidates() { return output; } });
    const response = await post({ requestId: 'r1', sourceText: '원문' });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'MODEL_RESPONSE_INVALID');
  }
  const { post } = await setup(t, { configured: true, async generateCandidates() { throw new Error('secret-provider-error'); } });
  const response = await post({ requestId: 'r1', sourceText: '원문' });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('secret-provider-error'));
});
test('timeout is enforced even when a provider ignores cancellation', async t => {
  const { post } = await setup(t, { configured: true, async generateCandidates() { return new Promise(() => {}); } }, 20);
  const response = await post({ requestId: 'r1', sourceText: '원문' });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'MODEL_TIMEOUT');
});
test('malformed JSON is a controlled error without leaking parser details', async t => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/api/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_INPUT');
});

test('provider failure kinds become actionable, safe application errors', async t => {
  for (const [kind, status, code] of [
    ['configuration', 503, 'MODEL_CONFIGURATION_ERROR'], ['quota', 429, 'MODEL_QUOTA_EXCEEDED'],
    ['blocked', 422, 'MODEL_BLOCKED'], ['invalid', 502, 'MODEL_RESPONSE_INVALID'], ['unavailable', 503, 'MODEL_UNAVAILABLE'],
  ] as const) {
    const { post } = await setup(t, { configured: true, async generateCandidates() { throw new ProviderError(kind); } });
    const response = await post({ requestId: 'failure-test', sourceText: '원문' });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(body.error.retryable, !['configuration', 'blocked'].includes(kind));
    assert.equal(body.requestId, 'failure-test');
  }
});

test('Gemini adapter and application contract work together with an explicitly simulated upstream', async t => {
  const provider = createGeminiProvider({ apiKey: 'test-only-key', model: 'gemini-test' }, async () => new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ candidates: ['금요일까지 자료를 보내주세요.'] }) }] } }],
  })));
  const { post } = await setup(t, provider);
  const response = await post({ requestId: 'integration-test', sourceText: '금요일까지 자료를 보내 주세여.' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidates[0].text, '금요일까지 자료를 보내주세요.');
  assert.ok(body.candidates[0].id);
  assert.equal(body.sourceText, '금요일까지 자료를 보내 주세여.');
});
test('multiline correction crosses Gemini adapter and API without silently shortening source or candidates', async t => {
  const sourceText = coverageCases[1].sourceText; // Explicit trailing LF.
  // The first two are historical reports, not acceptable quality examples.
  const candidates = [...coverageCases[0].reportedCandidates!, sourceText.replaceAll(' 입니다', '입니다')];
  let calls = 0;
  const provider = createGeminiProvider({ apiKey: 'test-only-key', model: 'gemini-test' }, async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(JSON.parse(request.contents[0].parts[0].text), { sourceText });
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: {
      parts: [{ text: JSON.stringify({ candidates }) }],
    } }] }));
  });
  const { post } = await setup(t, provider);
  const response = await post({ requestId: 'coverage-transport', sourceText });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sourceText, sourceText);
  assert.deepEqual(body.candidates.map((c: { text: string }) => c.text), candidates);
  assert.equal(calls, 1);
  // Documents the current limit: schema checks do not reject semantic omissions.
});

test('explanation API validates input, output correspondence, timeout and safe failure', async t => {
  const input = { requestId: 'explain', sourceText: '목요일', candidates: [{ id: 'one', text: '이후' }] };
  let calls = 0;
  const { base } = await setup(t, { configured: true, async generateCandidates() { throw Error('wrong method'); },
    async generateExplanations(source, candidates) {
      calls++; assert.equal(source, input.sourceText); assert.deepEqual(candidates, input.candidates);
      return [{ candidateId: 'one', explanation: '날짜가 불분명해졌습니다.' }];
    } });
  const post = (body: unknown) => fetch(`${base}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ ...input, document: '보내지 않을 주변 문맥' })).status, 400);
  assert.equal((await post({ ...input, candidates: [input.candidates[0], input.candidates[0]] })).status, 400);
  assert.equal(calls, 0);
  const response = await post(input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...input, explanations: [{ candidateId: 'one', explanation: '날짜가 불분명해졌습니다.' }] });
  for (const [mode, status] of [['mismatch', 502], ['timeout', 504], ['quota', 429]] as const) {
    const isolated = await setup(t, { configured: true, async generateCandidates() { return ['후보']; }, async generateExplanations() {
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'quota') throw new ProviderError('quota');
      return [{ candidateId: 'foreign', explanation: '틀린 연결' }];
    } }, 20);
    const failed = await fetch(`${isolated.base}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(failed.status, status);
    assert.equal((await failed.json()).requestId, input.requestId);
  }
});
test('explanation API withholds mismatched quotations without changing candidates or retrying the provider', async t => {
  const input = { requestId: 'quote', sourceText: '금요일까지 자료를 보내 주세여.', candidates: [
    { id: 'spaced', text: '금요일까지 자료를 보내 주세요.' },
    { id: 'joined', text: '금요일까지 자료를 보내주세요.' },
  ] };
  let calls = 0;
  let correct = false;
  const { base } = await setup(t, { configured: true, async generateCandidates() { throw Error('must not regenerate'); }, async generateExplanations() {
    calls++;
    return [{ candidateId: 'spaced', explanation: "'주세여'를 '주세요'로 고쳤습니다." },
      { candidateId: 'joined', explanation: correct ? "'보내 주세여'를 '보내주세요'로 수정했습니다." : "'보내 주세여'를 '보내 주세요'로 수정하면서 붙여 썼습니다." }];
  } });
  const post = () => fetch(`${base}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const response = await post();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.candidates, input.candidates);
  assert.deepEqual(body.explanations, [
    { candidateId: 'spaced', explanation: "'주세여'를 '주세요'로 고쳤습니다." },
    { candidateId: 'joined', error: 'EXPLANATION_QUOTE_MISMATCH' },
  ]);
  assert.equal(calls, 1);
  correct = true;
  const retried = await post();
  assert.equal(retried.status, 200);
  assert.deepEqual((await retried.json()).candidates, input.candidates);
  assert.equal(calls, 2);
});

test('structured provider results travel through HTTP without hiding valid candidates or treating all failures as success text', async t => {
  const input = { requestId: 'partial-http', sourceText: '세상에서 하나였다.', candidates: [
    { id: 'one', text: '세상에서 유일했다.' }, { id: 'two', text: '세상에서 하나뿐이었다.' },
  ] };
  let calls = 0;
  const provider = createGeminiProvider({ apiKey: 'fake-test-key', model: 'gemini-test' }, async () => {
    calls++;
    const value = { explanations: [
      { candidateId: 'one', references: [{ before: '하나였다', after: '유일했다' }], explanation: '유일하다는 하나뿐임을 나타내는 말입니다.' },
      { candidateId: 'two', references: [{ before: '하나였다', after: '유일하다' }], explanation: '잘못된 근거이므로 표시하면 안 되는 설명' },
    ] };
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
  });
  const { base } = await setup(t, provider);
  for (const sourceText of [input.sourceText, '다른 원문']) {
    const response = await fetch(`${base}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, sourceText }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.candidates, input.candidates);
    assert.deepEqual(body.explanations[1], { candidateId: 'two', error: 'EXPLANATION_QUOTE_MISMATCH' });
    assert.equal('explanation' in body.explanations[0], sourceText === input.sourceText);
    assert.ok(!JSON.stringify(body).includes('표시하면 안 되는 설명'));
  }
  assert.equal(calls, 2);
});
