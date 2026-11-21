import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';
import type { CorrectionProvider } from '../server/llm/provider.js';
import { explanationOutputSchema } from '../shared/contracts.js';
import meetingCases from './fixtures/explanation-manual-meeting-2026-11-22.json';

// Injected provider envelopes test API behavior, not live model quality.
const meeting = meetingCases.find(item => item.id === 'M-01')!;
const { sourceText, candidates } = meeting;
const [spacingCandidate, modelCandidate, failedCandidate] = candidates;
const spacingExplanation = '공백 5개를 추가하고 4개를 삭제했습니다. 원문 비교에서 공백이 바뀐 위치가 의도에 맞는지 확인해 주세요.';
const modelExplanation = '‘공유 하겠습니다’를 ‘공유해 드리겠습니다’로 바꾸었습니다.';
const badExplanation = '‘원문에 없는 회의 종료 문구’로 바꾸었습니다.';
const retryExplanation = '‘회의 자료는’을 ‘회의 자료를’로 바꾸었습니다.';
const config = { apiKey: 'fake-test-only-key', model: 'gemini-test-model',
  baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' };
type ProviderName = 'gemini' | 'elice';

function completion(name: ProviderName, text: string) {
  return Response.json(name === 'gemini'
    ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
    : { choices: [{ finish_reason: 'stop', message: { content: text } }] });
}

function providerWith(name: ProviderName, fetcher: typeof fetch) {
  return name === 'gemini' ? createGeminiProvider(config, fetcher) : createEliceProvider(config, fetcher);
}

async function setup(t: TestContext, provider: CorrectionProvider) {
  const server = createApp(provider).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/explanations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

for (const name of ['gemini', 'elice'] as const) {
  test(`${name}: HTTP spacing replacement preserves other explanations and permits a one-candidate retry`, async t => {
    let calls = 0;
    let retrying = false;
    const provider = providerWith(name, async (_url, options) => {
      calls++;
      const request = JSON.parse(String(options?.body));
      const sent = JSON.parse(name === 'gemini' ? request.contents[0].parts[0].text : request.messages[1].content);
      assert.deepEqual(sent, { sourceText, candidates: retrying ? [failedCandidate] : candidates });
      // Deliberately reorder IDs: replacement and failures must follow ownership.
      const explanations = retrying ? [{ candidateId: failedCandidate.id, explanation: retryExplanation }] : [
        { candidateId: failedCandidate.id, explanation: badExplanation },
        { candidateId: spacingCandidate.id, explanation: badExplanation },
        { candidateId: modelCandidate.id, explanation: modelExplanation },
      ];
      return completion(name, JSON.stringify({ explanations }));
    });
    const post = await setup(t, provider);
    const response = await post({ requestId: `spacing-${name}`, sourceText, candidates });
    assert.equal(response.status, 200);
    const result = explanationOutputSchema.parse(await response.json());
    assert.equal(result.sourceText, sourceText);
    assert.deepEqual(result.candidates, candidates);
    assert.deepEqual(result.explanations, [
      { candidateId: failedCandidate.id, error: 'EXPLANATION_QUOTE_MISMATCH' },
      { candidateId: spacingCandidate.id, explanation: spacingExplanation },
      { candidateId: modelCandidate.id, explanation: modelExplanation },
    ]);
    assert.ok(!JSON.stringify(result).includes(badExplanation));
    assert.equal(calls, 1); // Replacement does not skip the call or trigger a hidden retry.

    retrying = true;
    const retried = await post({ requestId: `spacing-retry-${name}`, sourceText, candidates: [failedCandidate] });
    assert.equal(retried.status, 200);
    const retryResult = explanationOutputSchema.parse(await retried.json());
    assert.deepEqual(retryResult.candidates, [failedCandidate]);
    assert.deepEqual(retryResult.explanations, [{ candidateId: failedCandidate.id, explanation: retryExplanation }]);
    assert.equal(calls, 2); // One additional call for the explicitly retried candidate only.
  });

  test(`${name}: spacing-eligible input cannot bypass upstream failure, damaged JSON or missing IDs`, async t => {
    const scenarios = [
      { id: 'upstream-503', candidates: [spacingCandidate], status: 503, code: 'MODEL_UNAVAILABLE',
        response: () => Response.json({ error: { message: 'Service unavailable' } }, { status: 503 }) },
      { id: 'damaged-json', candidates: [spacingCandidate], status: 502, code: 'MODEL_RESPONSE_INVALID',
        response: () => completion(name, '{"explanations":') },
      { id: 'missing-spacing-id', candidates, status: 502, code: 'MODEL_RESPONSE_INVALID',
        response: () => completion(name, JSON.stringify({ explanations: [
          { candidateId: modelCandidate.id, explanation: modelExplanation },
          { candidateId: failedCandidate.id, explanation: retryExplanation },
        ] })) },
    ];
    let calls = 0;
    let current = scenarios[0];
    const provider = providerWith(name, async () => { calls++; return current.response(); });
    const post = await setup(t, provider);
    for (const scenario of scenarios) {
      current = scenario;
      const before = calls;
      const requestId = `spacing-${name}-${scenario.id}`;
      const response = await post({ requestId, sourceText, candidates: scenario.candidates });
      assert.equal(response.status, scenario.status, scenario.id);
      const result = await response.json();
      assert.equal(result.requestId, requestId);
      assert.equal(result.error.code, scenario.code, scenario.id);
      assert.equal(result.error.retryable, true);
      assert.equal(result.candidates, undefined);
      assert.equal(result.explanations, undefined);
      assert.equal(calls - before, 1, `${scenario.id}: no implicit retry or provider fallback`);
    }
  });
}
