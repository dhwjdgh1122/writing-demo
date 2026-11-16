import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderExplanations, explanationResponseSchema } from '../server/llm/explanation-output.js';
import { ProviderError } from '../server/llm/provider.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';

const source = '자료를 확인한후 연락해 주세요.';
const candidates = [{ id: 'one', text: '자료를 확인한 후 연락해 주세요.' }];
const draft = () => ({ candidateId: 'one', references: [
  { side: 'source', text: '확인한후' }, { side: 'candidate', text: '확인한 후' },
], meaningChanges: [], changeSummary: '{{0}}를 {{1}}로 띄어 썼습니다.', guidance: '' });
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
    { ...draft(), references: [{ side: 'candidate', text: '즉시' }], meaningChanges: [], changeSummary: '{{0}}로 바뀌었습니다.' },
    { candidateId: 'two', references: [{ side: 'candidate', text: '즉시' }], meaningChanges: [], changeSummary: '{{0}}로 바뀌었습니다.', guidance: '' },
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
  const lengthy = { candidateId: 'one', references: [{ side: 'source', text: longSource }], meaningChanges: [], changeSummary: '{{0}}{{0}}', guidance: '' };
  assert.throws(() => renderExplanations(longSource, [{ id: 'one', text: '후보' }], { explanations: [lengthy] }), invalid);
  assert.equal(renderExplanations(longSource, [{ id: 'one', text: '후보' }], { explanations: [{ ...lengthy, meaningChanges: [], changeSummary: '{{0}}' }] })[0].explanation,
    `‘${longSource}’`);
  assert.equal(renderExplanations(source, [{ id: 'one', text: source }], { explanations: [{ candidateId: 'one', references: [], meaningChanges: [], changeSummary: '잘못된 모델 설명', guidance: '' }] })[0].explanation,
    '원문과 동일하여 변경된 표현이나 의미가 없습니다.');
});

test('literal reference contents are inserted once, including braces, whitespace and emoji', () => {
  const literal = '🌊 {{1}}\n자료';
  const one = { candidateId: 'one', references: [{ side: 'source', text: literal }], meaningChanges: [], changeSummary: '{{0}}를 줄였습니다.', guidance: '' };
  assert.equal(renderExplanations(literal, [{ id: 'one', text: '자료' }], { explanations: [one] })[0].explanation,
    `‘${literal}’를 줄였습니다.`);
});

test('reference validation does not claim to check unquoted meaning, completeness or grammatical direction', () => {
  const unsupported = { ...draft(), meaningChanges: [], changeSummary: '{{0}}를 {{1}}로 바꾸어 발송 날짜가 확정되었습니다.' };
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

const complexSource = '승인되면 8명에게 보낼 예정입니다.';
const complexCandidate = [{ id: 'one', text: '10명에게 보냅니다.' }];
const complexDraft = () => ({ candidateId: 'one', references: [
  { side: 'source', text: '승인되면' }, { side: 'source', text: '8명' },
  { side: 'candidate', text: '10명' }, { side: 'source', text: '보낼 예정입니다.' },
  { side: 'candidate', text: '보냅니다.' },
], meaningChanges: [
  { kind: 'condition', sourceRefs: [0], candidateRefs: [] },
  { kind: 'quantity', sourceRefs: [1], candidateRefs: [2] },
  { kind: 'certainty', sourceRefs: [3], candidateRefs: [4] },
], changeSummary: '{{0}} 조건이 빠지고 {{1}} 대신 {{2}} 인원으로 바뀌었으며 {{3}} 대신 {{4}} 표현을 사용해 발송이 확정되었습니다.', guidance: '' });
const renderComplex = (value: unknown) => renderExplanations(complexSource, complexCandidate, { explanations: [value] })[0].explanation;
const stage = (expected: string) => (error: unknown) => error instanceof ProviderError && error.kind === 'invalid' && error.validationFailure === expected;

test('every declared meaningful change contributes original information, never conflicting candidate values, to preservation guidance', () => {
  const explanation = renderComplex(complexDraft());
  const guidance = explanation.slice(explanation.indexOf('원래 뜻'));
  for (const original of ['승인되면', '8명', '보낼 예정입니다.']) assert.ok(guidance.includes(original));
  for (const replacement of ['10명', '보냅니다.']) assert.ok(!guidance.includes(replacement));
  const repeated = complexDraft();
  repeated.meaningChanges.push(repeated.meaningChanges[0]);
  assert.equal(renderComplex(repeated), explanation); // Shared evidence is not repeated in the final guidance.
});

test('rejects wrong-side, missing, duplicate and summary-disconnected meaning references and conflicting free-form guidance', () => {
  for (const change of [
    { kind: 'quantity', sourceRefs: [2], candidateRefs: [1] },
    { kind: 'quantity', sourceRefs: [11], candidateRefs: [2] },
    { kind: 'quantity', sourceRefs: [1, 1], candidateRefs: [2] },
    { kind: 'quantity', sourceRefs: [], candidateRefs: [] },
  ]) assert.throws(() => renderComplex({ ...complexDraft(), meaningChanges: [change] }), stage('meaning-link'));
  assert.throws(() => renderComplex({ ...complexDraft(), changeSummary: '{{0}} 조건이 사라졌습니다.' }), stage('meaning-link'));
  assert.throws(() => renderComplex({ ...complexDraft(), guidance: '{{1}} 내용과 {{2}} 내용을 유지하면 됩니다.' }), stage('meaning-link'));
});

test('handles added-only information separately instead of recommending it as original information', () => {
  const addition = { candidateId: 'one', references: [{ side: 'candidate', text: '내일' }],
    meaningChanges: [{ kind: 'date', sourceRefs: [], candidateRefs: [0] }],
    changeSummary: '{{0}} 날짜가 추가되었습니다.', guidance: '' };
  const text = renderExplanations('자료를 보냅니다.', [{ id: 'one', text: '내일 자료를 보냅니다.' }], { explanations: [addition] })[0].explanation;
  assert.ok(text.includes('원문에 없어'));
  assert.ok(!text.includes('유지하는 편'));
  assert.throws(() => renderExplanations('내일 자료를 보냅니다.', [{ id: 'one', text: '내일 보냅니다.' }], { explanations: [addition] }), stage('meaning-link'));
});

test('enforces final length after generated guidance and reports only bounded validation stages', () => {
  const long = '가'.repeat(200);
  const value = { candidateId: 'one', references: [{ side: 'source', text: long }],
    meaningChanges: [{ kind: 'other', sourceRefs: [0], candidateRefs: [] }], changeSummary: '{{0}} 내용이 삭제되었습니다.', guidance: '' };
  assert.throws(() => renderExplanations(long, [{ id: 'one', text: '나' }], { explanations: [value] }), stage('length'));
  assert.throws(() => renderComplex({ ...complexDraft(), meaningChanges: undefined }), stage('schema'));
  assert.throws(() => renderComplex({ ...complexDraft(), candidateId: 'unknown' }), stage('ids'));
  assert.throws(() => renderComplex({ ...complexDraft(), references: [{ side: 'source', text: 'sensitive absent' }] }), stage('reference'));
  assert.throws(() => renderComplex({ ...complexDraft(), changeSummary: '{{99}}' }), stage('template'));
});

test('undeclared meaning changes remain a model-quality limitation, not a successful semantic check', () => {
  const incomplete = { ...complexDraft(), meaningChanges: [] };
  assert.ok(!renderComplex(incomplete).includes('원래 뜻')); // Prompt compliance must still be assessed on real cases.
});

test('compact provider schema still enforces full nested bounds locally', () => {
  const shape = explanationResponseSchema(complexCandidate).properties.explanations.items.properties.meaningChanges;
  assert.ok(!('maxItems' in shape));
  const one = complexDraft();
  assert.throws(() => renderComplex({ ...one, meaningChanges: Array(13).fill(one.meaningChanges[0]) }), stage('schema'));
  for (const indices of [[-1], [12], [0.5], Array(13).fill(0)]) {
    assert.throws(() => renderComplex({ ...one, meaningChanges: [{ kind: 'condition', sourceRefs: indices, candidateRefs: [] }] }), stage('schema'));
  }
});
