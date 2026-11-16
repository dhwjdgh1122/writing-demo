import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderExplanations } from '../server/llm/explanation-output.js';
import { ProviderError } from '../server/llm/provider.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';

const source = '자료를 확인한후 연락해 주세요.';
const candidates = [{ id: 'one', text: '자료를 확인한 후 연락해 주세요.' }];
const draft = () => ({ candidateId: 'one', references: [
  { side: 'source', text: '확인한후' }, { side: 'candidate', text: '확인한 후' },
], changeSummary: '{{0}}를 {{1}}로 띄어 썼습니다.', guidance: '' });
const invalid = (error: unknown) => error instanceof ProviderError && error.kind === 'invalid';

test('renders only exact, side-bound references and joins optional guidance without exposing templates', () => {
  const changed = { ...draft(), guidance: '{{0}}의 공백을 수정한 내용입니다.' };
  assert.deepEqual(renderExplanations(source, candidates, { explanations: [changed] }), [{
    candidateId: 'one', explanation: '‘확인한후’를 ‘확인한 후’로 띄어 썼습니다. ‘확인한후’의 공백을 수정한 내용입니다.',
  }]);
  assert.equal(renderExplanations(source, candidates, { explanations: [draft()] })[0].explanation,
    '‘확인한후’를 ‘확인한 후’로 띄어 썼습니다.');
});

test('rejects observed fabricated text, normalized typos, wrong side and cross-candidate citations', () => {
  for (const bad of [
    { side: 'source', text: '확한후' }, // F S-02 unquoted fabrication, now a reference.
    { side: 'source', text: '확인한 후' }, // Incorrectly normalizing the source.
    { side: 'candidate', text: '확인한후' },
    { side: 'source', text: '확인한\n후' },
    { side: 'source', text: ' ' },
  ]) assert.throws(() => renderExplanations(source, candidates, { explanations: [{ ...draft(), references: [bad, draft().references[1]] }] }), invalid);
  const typo = { ...draft(), references: [{ side: 'source', text: '주세여' }, { side: 'candidate', text: '주세오' }] };
  assert.throws(() => renderExplanations('보내 주세여.', [{ id: 'one', text: '보내 주세요.' }], { explanations: [typo] }), invalid);
  const other = { id: 'two', text: '즉시 확인해 주세요.' };
  assert.throws(() => renderExplanations(source, [...candidates, other], { explanations: [
    { ...draft(), references: [{ side: 'candidate', text: '즉시' }], changeSummary: '{{0}}로 바뀌었습니다.' },
    { candidateId: 'two', references: [{ side: 'candidate', text: '즉시' }], changeSummary: '{{0}}로 바뀌었습니다.', guidance: '' },
  ] }), invalid);
});

test('rejects missing, unused, malformed and literal quotes instead of silently dropping or repairing data', () => {
  for (const changeSummary of ['{{2}}', '{{-1}}', '{{01}}', '{{x}}', '{{0}', '{{0}}', '수정했습니다.', "'확인한후'를 수정했습니다.", '   ']) {
    assert.throws(() => renderExplanations(source, candidates, { explanations: [{ ...draft(), changeSummary }] }), invalid);
  }
  assert.throws(() => renderExplanations(source, candidates, { explanations: [{ ...draft(), references: [] }] }), invalid);
  assert.throws(() => renderExplanations(source, candidates, { explanations: [{ ...draft(), explanation: 'legacy' }] }), invalid);
});

test('validates IDs, final expanded code-point length and fixed unchanged handling', () => {
  for (const explanations of [[], [draft(), draft()], [{ ...draft(), candidateId: 'unknown' }]]) {
    assert.throws(() => renderExplanations(source, candidates, { explanations }), invalid);
  }
  const longSource = '🌊'.repeat(200);
  const lengthy = { candidateId: 'one', references: [{ side: 'source', text: longSource }], changeSummary: '{{0}}{{0}}', guidance: '' };
  assert.throws(() => renderExplanations(longSource, [{ id: 'one', text: '후보' }], { explanations: [lengthy] }), invalid);
  assert.equal(renderExplanations(longSource, [{ id: 'one', text: '후보' }], { explanations: [{ ...lengthy, changeSummary: '{{0}}' }] })[0].explanation,
    `‘${longSource}’`);
  assert.equal(renderExplanations(source, [{ id: 'one', text: source }], { explanations: [{ candidateId: 'one', references: [], changeSummary: '잘못된 모델 설명', guidance: '' }] })[0].explanation,
    '원문과 동일하여 변경된 표현이나 의미가 없습니다.');
});

test('literal reference contents are inserted once, including braces, whitespace and emoji', () => {
  const literal = '🌊 {{1}}\n자료';
  const one = { candidateId: 'one', references: [{ side: 'source', text: literal }], changeSummary: '{{0}}를 줄였습니다.', guidance: '' };
  assert.equal(renderExplanations(literal, [{ id: 'one', text: '자료' }], { explanations: [one] })[0].explanation,
    `‘${literal}’를 줄였습니다.`);
});

test('reference validation does not claim to check unquoted meaning, completeness or grammatical direction', () => {
  const unsupported = { ...draft(), changeSummary: '{{0}}를 {{1}}로 바꾸어 발송 날짜가 확정되었습니다.' };
  assert.match(renderExplanations(source, candidates, { explanations: [unsupported] })[0].explanation, /발송 날짜가 확정/);
  // Both strings exist on the right sides; the semantic claim still needs evaluation.
});

test('both adapters reject invalid reference results without retry, fallback or leaking model text', async () => {
  const decoded = { explanations: [{ ...draft(), references: [{ side: 'source', text: 'sensitive invented content' }] }] };
  for (const providerName of ['gemini', 'elice']) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json(providerName === 'gemini'
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(decoded) }] } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decoded) } }] });
    };
    const provider = providerName === 'gemini'
      ? createGeminiProvider({ apiKey: 'test', model: 'gemini-test' }, fetcher)
      : createEliceProvider({ apiKey: 'test', model: 'test', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' }, fetcher);
    await assert.rejects(provider.generateExplanations!(source, candidates, new AbortController().signal), e => invalid(e) && !String(e).includes('sensitive'));
    assert.equal(calls, 1);
  }
});
