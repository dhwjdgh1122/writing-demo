import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { ProviderError, type CorrectionProvider } from '../server/llm/provider.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';
import { explanationInstruction } from '../server/llm/prompt.js';
import coverageCases from './fixtures/correction-coverage-cases.json';

for (const name of ['gemini', 'elice'] as const) {
  test(`${name}: existing model format isolates malformed and mismatched candidate explanations through HTTP`, async t => {
    const sourceText = '회의를\n시작합니다.';
    const candidates = [{ id: 'good', text: '회의를\n진행합니다.' }, { id: 'bad', text: '회의를\n엽니다.' }, { id: 'format', text: '회의가 시작됩니다.' }];
    let calls = 0;
    let malformed: Record<string, unknown> = {};
    const providerConfig = { apiKey: 'fake-test-key', model: 'gemini-test', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' };
    const fetcher: typeof fetch = async (_url, options) => {
      calls++;
      const request = JSON.parse(String(options?.body));
      assert.equal(name === 'gemini' ? request.systemInstruction.parts[0].text : request.messages[0].content, explanationInstruction);
      assert.deepEqual(JSON.parse(name === 'gemini' ? request.contents[0].parts[0].text : request.messages[1].content), { sourceText, candidates });
      if (name === 'gemini') assert.deepEqual(request.generationConfig.responseJsonSchema.properties.explanations.items.required, ['candidateId', 'explanation']);
      const text = JSON.stringify({ explanations: [
        { candidateId: 'format', ...malformed },
        { candidateId: 'good', explanation: '‘회의를\n시작합니다.’가 ‘회의를\n진행합니다.’로 바뀌었습니다.' },
        { candidateId: 'bad', explanation: '‘회의를\n종료합니다.’로 바뀌었습니다.' },
      ] });
      return Response.json(name === 'gemini'
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: text } }] });
    };
    const provider = name === 'gemini' ? createGeminiProvider(providerConfig, fetcher) : createEliceProvider(providerConfig, fetcher);
    const { base } = await setup(t, provider);
    for (const invalid of [{}, { explanation: ' ' }, { explanation: '가'.repeat(401) }, { explanation: 5 }, { explanation: '설명', extra: true }, { error: 'EXPLANATION_INVALID' }]) {
      malformed = invalid;
      const response = await fetch(`${base}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: `partial-${name}`, sourceText, candidates }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.candidates, candidates);
      assert.deepEqual(body.explanations[0], { candidateId: 'format', error: 'EXPLANATION_INVALID' });
      assert.match(body.explanations[1].explanation, /회의를\n진행합니다/);
      assert.deepEqual(body.explanations[2], { candidateId: 'bad', error: 'EXPLANATION_QUOTE_MISMATCH' });
      assert.ok(!JSON.stringify(body.explanations).includes('종료합니다'));
    }
    assert.equal(calls, 6); // One call per explicit request; no hidden retry.
  });

  test(`${name}: ambiguous IDs or malformed envelopes still reject the entire response`, async () => {
    const candidates = [{ id: 'one', text: '후보 하나' }, { id: 'two', text: '후보 둘' }];
    const good = { candidateId: 'one', explanation: '설명' };
    const fixtures = [null, {}, { explanations: [good] }, { explanations: [good, good] },
      { explanations: [good, { candidateId: 'foreign', explanation: '설명' }] },
      { explanations: [good, { explanation: 'ID 누락' }] },
      { explanations: [good, { candidateId: 'two', explanation: '설명' }], extra: true },
      { explanations: [good, { candidateId: 'two', explanation: '설명' }, good, good] }];
    for (const raw of fixtures) {
      const fetcher: typeof fetch = async () => {
        const text = JSON.stringify(raw);
        return Response.json(name === 'gemini'
          ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
          : { choices: [{ finish_reason: 'stop', message: { content: text } }] });
      };
      const config = { apiKey: 'fake-test-key', model: 'gemini-test', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' };
      const provider = name === 'gemini' ? createGeminiProvider(config, fetcher) : createEliceProvider(config, fetcher);
      await assert.rejects(provider.generateExplanations!('원문', candidates, new AbortController().signal), error => error instanceof ProviderError && error.kind === 'invalid');
    }
  });

  test(`${name}: output-limit responses never expose partial results and give correction-specific recovery guidance`, async t => {
    for (const explaining of [false, true]) {
      for (const validJson of [false, true]) {
        let calls = 0;
        const input = { requestId: `truncated-${name}`, sourceText: ' 원문\n',
          ...(explaining ? { candidates: [{ id: 'one', text: '교정 후보' }] } : {}) };
        const raw = validJson
          ? JSON.stringify(explaining ? { explanations: [{ candidateId: 'one', explanation: '표시하면 안 되는 응답' }] }
            : { candidates: ['표시하면 안 되는 응답'] })
          : '{"incomplete":"표시하면 안 되는 응답';
        const fetcher: typeof fetch = async (_url, options) => {
          calls++;
          const request = JSON.parse(String(options?.body));
          const sent = JSON.parse(name === 'gemini' ? request.contents[0].parts[0].text : request.messages[1].content);
          assert.deepEqual(sent, explaining ? { sourceText: input.sourceText, candidates: input.candidates } : { sourceText: input.sourceText });
          return Response.json(name === 'gemini'
            ? { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: raw }] } }] }
            : { choices: [{ finish_reason: 'length', message: { content: raw } }] });
        };
        const config = { apiKey: 'fake-test-key', model: 'gemini-test', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' };
        const provider = name === 'gemini' ? createGeminiProvider(config, fetcher) : createEliceProvider(config, fetcher);
        const { base } = await setup(t, provider);
        const response = await fetch(`${base}/api/${explaining ? 'explanations' : 'corrections'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
        });
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.equal(body.requestId, input.requestId);
        assert.equal(body.error.code, 'MODEL_OUTPUT_TRUNCATED');
        assert.equal(body.error.retryable, true);
        assert.match(body.error.message, explaining ? /교정 후보는 유지.*원문 비교와 적용/ : /원문은 유지.*선택 범위를 줄여/);
        assert.equal(body.candidates, undefined);
        assert.equal(body.explanations, undefined);
        assert.ok(!JSON.stringify(body).includes('표시하면 안 되는 응답'));
        assert.equal(calls, 1);
      }
    }
  });
}

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
    ['blocked', 422, 'MODEL_BLOCKED'], ['truncated', 502, 'MODEL_OUTPUT_TRUNCATED'], ['invalid', 502, 'MODEL_RESPONSE_INVALID'], ['unavailable', 503, 'MODEL_UNAVAILABLE'],
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
