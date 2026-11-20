import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNumericEvidence, augmentExplanationRequest, numericEvidenceInstruction } from '../scripts/lib/explanation-numeric-evidence.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';
import { explanationInstruction } from '../server/llm/prompt.js';
import { ProviderError } from '../server/llm/provider.js';

const evidence = (source: string, candidate: string) => buildNumericEvidence(source, [{ id: 'one', text: candidate }])[0];

test('numeric evidence preserves exact spellings, independent counts and candidate ownership', () => {
  assert.deepEqual(buildNumericEvidence('8명 18명 8명\n1,000원', [
    { id: 'changed', text: '18명 10명\n1000원' },
    { id: 'same-counts', text: '1,000원\n8명 8명 18명' },
  ]), [
    { candidateId: 'changed', status: 'differences', source: [{ text: '8', count: 2 }, { text: '1,000', count: 1 }], candidate: [{ text: '10', count: 1 }, { text: '1000', count: 1 }] },
    { candidateId: 'same-counts', status: 'no-spelling-difference', source: [], candidate: [] },
  ]);
  for (const [source, candidate] of [['1,000', '1000'], ['08', '8'], ['1.5', '15'], ['3,50', '3.50']]) {
    assert.deepEqual(evidence(source, candidate), {
      candidateId: 'one', status: 'differences', source: [{ text: source, count: 1 }], candidate: [{ text: candidate, count: 1 }],
    });
  }
});

test('numeric additions and deletions retain empty sides without assigning replacement pairs', () => {
  assert.deepEqual(evidence('자료를 보냅니다.', '15명에게 자료를 보냅니다.'), {
    candidateId: 'one', status: 'differences', source: [], candidate: [{ text: '15', count: 1 }],
  });
  assert.deepEqual(evidence('8명 중 2명에게 안내합니다.', '8명에게 안내합니다.'), {
    candidateId: 'one', status: 'differences', source: [{ text: '2', count: 1 }], candidate: [],
  });
  assert.deepEqual(evidence('8명과 8명에게 2개씩', '8명에게 3개씩'), {
    candidateId: 'one', status: 'differences', source: [{ text: '8', count: 2 }, { text: '2', count: 1 }], candidate: [{ text: '8', count: 1 }, { text: '3', count: 1 }],
  });
});

test('equal spelling counts do not certify unchanged roles, signs, units, conditions or number words', () => {
  for (const [source, candidate] of [
    ['A는 8명, B는 10명', 'A는 10명, B는 8명'], ['8명', '8개'], ['-8', '8'],
    ['승인되면 8명', '8명'], ['열 명', '여덟 명'], ['회원인 경우에만', '회원만'], ['원문', '후보'],
  ]) assert.deepEqual(evidence(source, candidate), { candidateId: 'one', status: 'no-spelling-difference', source: [], candidate: [] });
});

test('over-limit evidence is distinct from no difference and is never a partial summary', () => {
  assert.equal(evidence('1 2 3', '4 5 6').status, 'differences');
  assert.equal(evidence('1'.repeat(24), '2').status, 'differences');
  for (const [source, candidate] of [['1 2 3', '4 5 6 7'], ['1'.repeat(25), '2'], ['1 2', '3 ' + '4'.repeat(25)]]) {
    assert.deepEqual(evidence(source, candidate), { candidateId: 'one', status: 'omitted-over-limit', source: [], candidate: [] });
  }
  // Bounds apply to changed spellings, as in the reused Draft #34 algorithm.
  assert.equal(evidence('1'.repeat(25), '1'.repeat(25)).status, 'no-spelling-difference');
});

const sourceText = '목요일에 8명에게 안내합니다.';
const candidates = [{ id: 'good', text: '목요일에 10명에게 안내합니다.' }, { id: 'bad', text: '목요일에 12명에게 안내합니다.' }];

for (const name of ['gemini', 'elice'] as const) {
  test(`${name}: real adapter with injected offline fetch changes only instruction suffix and numeric input`, async () => {
    let calls = 0;
    const abort = new AbortController().signal;
    const fetcher: typeof fetch = async (_url, options) => {
      calls++;
      const original = JSON.parse(String(options?.body));
      const saved = structuredClone(original);
      const augmented = augmentExplanationRequest(name, original);
      assert.notEqual(augmented, original);
      assert.deepEqual(original, saved);
      assert.equal(options?.signal, abort);
      assert.equal(options?.redirect, 'error');
      const originalInput = JSON.parse(name === 'gemini' ? original.contents[0].parts[0].text : original.messages[1].content);
      assert.deepEqual(originalInput, { sourceText, candidates });
      const input = JSON.parse(name === 'gemini' ? augmented.contents[0].parts[0].text : augmented.messages[1].content);
      assert.deepEqual(input, { sourceText, candidates, numericEvidence: buildNumericEvidence(sourceText, candidates) });
      const instruction = name === 'gemini' ? augmented.systemInstruction.parts[0].text : augmented.messages[0].content;
      assert.equal(instruction, `${explanationInstruction}\n${numericEvidenceInstruction}`);
      const restored = structuredClone(augmented);
      if (name === 'gemini') {
        assert.deepEqual(augmented.generationConfig, original.generationConfig);
        assert.deepEqual(augmented.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
        assert.equal(augmented.generationConfig.maxOutputTokens, 8192);
        assert.equal(augmented.generationConfig.candidateCount, 1);
        assert.deepEqual(augmented.generationConfig.responseJsonSchema.properties.explanations.items.required, ['candidateId', 'explanation']);
        restored.systemInstruction.parts[0].text = original.systemInstruction.parts[0].text;
        restored.contents[0].parts[0].text = original.contents[0].parts[0].text;
      } else {
        assert.equal(augmented.model, 'gpt-4o-mini');
        assert.equal(augmented.max_tokens, 2000);
        assert.equal(augmented.stream, false);
        assert.equal(augmented.n, 1);
        assert.deepEqual(augmented.response_format, { type: 'json_object' });
        restored.messages[0].content = original.messages[0].content;
        restored.messages[1].content = original.messages[1].content;
      }
      assert.deepEqual(restored, original); // Every other body field is unchanged.
      assert.throws(() => augmentExplanationRequest(name, augmented), /Unsupported explanation request/);
      const text = JSON.stringify({ explanations: [
        { candidateId: 'good', explanation: '인원이 8명에서 10명으로 바뀌었습니다.' },
        { candidateId: 'bad', explanation: ' ' },
      ] });
      return Response.json(name === 'gemini'
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: text } }] });
    };
    const provider = name === 'gemini'
      ? createGeminiProvider({ apiKey: 'test-only-key', model: 'gemini-3.5-flash-lite' }, fetcher)
      : createEliceProvider({ apiKey: 'test-only-key', model: 'gpt-4o-mini', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' }, fetcher);
    assert.deepEqual(await provider.generateExplanations!(sourceText, candidates, abort), [
      { candidateId: 'good', explanation: '인원이 8명에서 10명으로 바뀌었습니다.' },
      { candidateId: 'bad', error: 'EXPLANATION_INVALID' },
    ]);
    assert.equal(calls, 1); // Mocked response only; no live fetch or hidden retry.
  });

  test(`${name}: augmentation preserves the adapter's rejection of wrong candidate IDs`, async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (_url, options) => {
      calls++;
      augmentExplanationRequest(name, JSON.parse(String(options?.body)));
      const text = JSON.stringify({ explanations: [{ candidateId: 'foreign', explanation: '설명' }] });
      return Response.json(name === 'gemini'
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: text } }] });
    };
    const provider = name === 'gemini'
      ? createGeminiProvider({ apiKey: 'test-only-key', model: 'gemini-3.5-flash-lite' }, fetcher)
      : createEliceProvider({ apiKey: 'test-only-key', model: 'gpt-4o-mini', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' }, fetcher);
    await assert.rejects(provider.generateExplanations!(sourceText, candidates, new AbortController().signal),
      error => error instanceof ProviderError && error.kind === 'invalid');
    assert.equal(calls, 1);
  });
}

test('request augmentation rejects other request shapes without leaking their content', () => {
  for (const body of [null, {}, { privateValue: 'do-not-print' },
    { systemInstruction: { parts: [{ text: explanationInstruction }] }, contents: [{ role: 'user', parts: [{ text: JSON.stringify({ sourceText }) }] }] },
  ]) assert.throws(() => augmentExplanationRequest('gemini', body), error => {
    assert.equal(String(error), 'Error: Unsupported explanation request for numeric evidence.');
    return true;
  });
  assert.throws(() => augmentExplanationRequest('unknown' as 'gemini', {}), /Unsupported explanation request/);
});
