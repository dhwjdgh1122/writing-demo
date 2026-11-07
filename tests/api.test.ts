import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { ProviderError, type CorrectionProvider } from '../server/llm/provider.js';
import { createGeminiProvider } from '../server/llm/gemini.js';

async function setup(t: TestContext, provider?: CorrectionProvider, timeoutMs?: number) {
  const server = createApp(provider, timeoutMs).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${address.port}`;
  return { base, post: (body: unknown) => fetch(`${base}/api/corrections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}
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
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'EXPLANATION_QUOTE_MISMATCH');
  assert.equal(body.error.retryable, true);
  assert.equal(body.explanations, undefined);
  assert.equal(calls, 1);
  correct = true;
  const retried = await post();
  assert.equal(retried.status, 200);
  assert.deepEqual((await retried.json()).candidates, input.candidates);
  assert.equal(calls, 2);
});
