import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderExplanations, explanationResponseSchema } from '../server/llm/explanation-output.js';
import { ProviderError } from '../server/llm/provider.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';

const source = '자료를 확인한후 연락해 주세요.';
const candidates = [{ id: 'one', text: '자료를 확인한 후 연락해 주세요.' }];
const draft = () => ({ candidateId: 'one', changes: [{ kind: 'spacing', before: '확인한후', after: '확인한 후', effect: '' }], notes: [] });
const render = (value: unknown) => renderExplanations(source, candidates, { explanations: [value] })[0].explanation;
const invalid = (error: unknown) => error instanceof ProviderError && error.kind === 'invalid';
const stage = (expected: string) => (error: unknown) => invalid(error) && (error as ProviderError).validationFailure === expected;

test('a change owns both quotes and is rendered exactly once without model-authored particles or reference indices', () => {
  assert.equal(render(draft()), '‘확인한후’ → ‘확인한 후’: 띄어쓰기 수정.');
  assert.ok(!render(draft()).includes('유지'));
});

test('rejects fabricated, normalized, wrong-side and cross-candidate evidence', () => {
  for (const before of ['확한후', '확인한 후', '확인한\n후', ' ']) {
    assert.throws(() => render({ ...draft(), changes: [{ ...draft().changes[0], before }] }), stage('reference'));
  }
  assert.throws(() => render({ ...draft(), changes: [{ ...draft().changes[0], after: '확인한후' }] }), stage('reference'));
  assert.throws(() => renderExplanations(source, [...candidates, { id: 'two', text: '즉시 확인해 주세요.' }], { explanations: [
    { ...draft(), changes: [{ kind: 'wording', before: '자료를', after: '즉시', effect: '' }] },
    { candidateId: 'two', changes: [{ kind: 'wording', before: '자료를 확인한후', after: '즉시 확인해', effect: '' }], notes: [] },
  ] }), stage('reference'));
});

test('spacing cannot conceal a changed letter and unchanged words cannot be claimed as changes', () => {
  assert.throws(() => renderExplanations('보내 주세여.', [{ id: 'one', text: '보내주세요.' }], { explanations: [
    { ...draft(), changes: [{ kind: 'spacing', before: '보내 주세여', after: '보내주세요', effect: '' }] },
  ] }), stage('change'));
  for (const change of [{ kind: 'usage', before: '자료를', after: '자료를', effect: '' }, { kind: 'other', before: '', after: '', effect: '변경' }]) {
    assert.throws(() => render({ ...draft(), changes: [change] }), stage('change'));
  }
  assert.throws(() => render({ ...draft(), changes: [] }), stage('change'));
});

test('surface labels are server-generated; free quotes, legacy templates and missing meaning effects are rejected', () => {
  assert.throws(() => render({ ...draft(), changes: [{ ...draft().changes[0], effect: '내용이 정확합니다' }] }), stage('change'));
  for (const effect of ['', ' ', '"새 문장"입니다', '{{0}}를 바꿨습니다', '첫 줄\n다음 줄']) {
    assert.throws(() => render({ ...draft(), changes: [{ ...draft().changes[0], kind: 'other', effect }] }), stage('change'));
  }
  assert.throws(() => render({ ...draft(), changeSummary: 'legacy' }), stage('schema'));
});

const complexSource = '승인되면 8명에게 보낼 예정입니다.';
const complexCandidate = [{ id: 'one', text: '10명에게 보냅니다.' }];
const complexDraft = () => ({ candidateId: 'one', changes: [
  { kind: 'condition', before: '승인되면', after: '', effect: '승인 없이 보낸다는 뜻이 됩니다' },
  { kind: 'quantity', before: '8명', after: '10명', effect: '받는 인원이 늘어납니다' },
  { kind: 'certainty', before: '보낼 예정입니다.', after: '보냅니다.', effect: '예정이 확정적인 표현으로 바뀝니다' },
], notes: [] });
const renderComplex = (value: unknown) => renderExplanations(complexSource, complexCandidate, { explanations: [value] })[0].explanation;

test('every supplied meaningful change renders its own evidence and effect; guidance deduplicates categories', () => {
  const text = renderComplex(complexDraft());
  for (const value of ['승인되면', '8명', '10명', '승인 없이', '받는 인원', '예정이 확정']) assert.ok(text.includes(value));
  const guidance = text.slice(text.indexOf('원래 뜻'));
  for (const label of ['조건', '수치·인원', '확정·예정·가능성']) assert.ok(guidance.includes(label));
  for (const quote of ['승인되면', '8명', '10명']) assert.ok(!guidance.includes(quote));
  assert.throws(() => renderComplex({ ...complexDraft(), changes: [...complexDraft().changes, complexDraft().changes[0]] }), stage('change'));
});

test('addition-only and deletion-only changes retain their direction and do not recommend new facts as original', () => {
  const d = { candidateId: 'one', changes: [{ kind: 'date', before: '', after: '내일', effect: '날짜가 새로 지정됩니다' }], notes: [] };
  const text = renderExplanations('자료를 보냅니다.', [{ id: 'one', text: '내일 자료를 보냅니다.' }], { explanations: [d] })[0].explanation;
  assert.ok(text.startsWith('‘내일’ 추가:'));
  assert.ok(text.includes('추가된 날짜·시간 정보'));
  assert.ok(!text.includes('원래 뜻'));
  assert.ok(renderComplex(complexDraft()).startsWith('‘승인되면’ 삭제:'));
});

test('remaining usage notes must quote the same unchanged expression in source and its own candidate', () => {
  const d = { candidateId: 'one', changes: [{ kind: 'spelling', before: '않앗습니다', after: '않았습니다', effect: '' }],
    notes: [{ text: '결재', reason: '대금 납부 맥락에 맞는 단어가 필요합니다' }] };
  const run = (value: unknown) => renderExplanations('아직 결재하지 않앗습니다.', [{ id: 'one', text: '아직 결재하지 않았습니다.' }], { explanations: [value] });
  assert.ok(run(d)[0].explanation.includes('남아 있는 ‘결재’ 표현'));
  assert.throws(() => run({ ...d, notes: [{ text: '결제', reason: '새 단어 제안' }] }), stage('reference'));
  assert.throws(() => run({ ...d, notes: [{ text: '않앗습니다', reason: '이미 수정됨' }] }), stage('reference'));
});

test('even a wrongly classified whole-source change cannot copy source typos into preservation guidance', () => {
  const before = '회의는 화요일에 시작됍니다.', after = '회의는 화요일에 시작됩니다.';
  const d = { candidateId: 'one', changes: [{ kind: 'action', before, after, effect: '표현이 바뀝니다' }], notes: [] };
  const result = renderExplanations(before, [{ id: 'one', text: after }], { explanations: [d] })[0].explanation;
  const guide = result.slice(result.indexOf('원래 뜻'));
  assert.ok(!guide.includes('됍니다'));
  assert.ok(guide.includes('행동 내용'));
  // Incorrect classification is still a model-quality issue, not validated here.
});

test('IDs and fixed unchanged handling remain strict', () => {
  for (const explanations of [[], [draft(), draft()], [{ ...draft(), candidateId: 'unknown' }]]) {
    assert.throws(() => renderExplanations(source, candidates, { explanations }), invalid);
  }
  assert.equal(renderExplanations(source, [{ id: 'one', text: source }], { explanations: [{ candidateId: 'one', changes: [], notes: [] }] })[0].explanation,
    '원문과 동일하여 변경된 표현이나 의미가 없습니다.');
});

test('final code-point limit includes evidence and guidance, without truncating the model response', () => {
  const before = '🌊'.repeat(350), after = '나';
  const make = (n: number) => ({ candidateId: 'one', changes: [{ kind: 'other', before: before.slice(0, n * 2), after, effect: '내용이 달라집니다' }], notes: [] });
  assert.throws(() => renderExplanations(before, [{ id: 'one', text: after }], { explanations: [make(350)] }), stage('length'));
  assert.ok(renderExplanations(before, [{ id: 'one', text: after }], { explanations: [make(100)] })[0].explanation.includes('🌊'.repeat(100)));
});

test('literal braces, whitespace and emoji in evidence are inserted once and never treated as templates', () => {
  const before = '🌊 {{1}}\n자료';
  const d = { candidateId: 'one', changes: [{ kind: 'wording', before, after: '자료', effect: '' }], notes: [] };
  assert.equal(renderExplanations(before, [{ id: 'one', text: '자료' }], { explanations: [d] })[0].explanation, `‘${before}’ → ‘자료’: 표현 다듬기.`);
});

test('string checks do not claim to detect missing meaning changes or false unquoted effects', () => {
  const d = { ...draft(), changes: [{ ...draft().changes[0], kind: 'date', effect: '발송 날짜가 확정됩니다' }] };
  assert.ok(render(d).includes('발송 날짜가 확정됩니다'));
  assert.ok(!renderComplex({ ...complexDraft(), changes: [complexDraft().changes[1]] }).includes('승인'));
});

test('manual observation is detached, before evidence checks, and absent on bad schema or candidate IDs', () => {
  const d = draft(); let calls = 0;
  const result = renderExplanations(source, candidates, { explanations: [d] }, rows => { calls++; rows[0].changes[0].before = 'mutated'; });
  assert.equal(result[0].explanation, render(d));
  assert.equal(d.changes[0].before, '확인한후');
  let captured: unknown;
  assert.throws(() => renderExplanations(source, candidates, { explanations: [{ ...d, changes: [{ ...d.changes[0], before: 'absent' }] }] }, rows => { captured = rows; }), stage('reference'));
  assert.ok(captured);
  for (const bad of [{ ...d, unknown: true }, { ...d, candidateId: 'other' }]) {
    assert.throws(() => renderExplanations(source, candidates, { explanations: [bad] }, () => { calls++; }), invalid);
  }
  assert.equal(calls, 1);
});

test('both adapters expose only bounded drafts and reject bad evidence without retry or provider-envelope leakage', async () => {
  for (const name of ['gemini', 'elice']) {
    let calls = 0, bad = false, captured: unknown;
    const fetcher: typeof fetch = async () => {
      calls++;
      const decoded = { explanations: [{ ...draft(), changes: [{ ...draft().changes[0], before: bad ? 'sensitive invented content' : '확인한후' }] }] };
      return Response.json(name === 'gemini'
        ? { providerSecret: 'not an explanation', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(decoded) }] } }] }
        : { providerSecret: 'not an explanation', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decoded) } }] });
    };
    const observe = (rows: unknown) => { captured = rows; };
    const provider = name === 'gemini'
      ? createGeminiProvider({ apiKey: 'test', model: 'gemini-test' }, fetcher, observe)
      : createEliceProvider({ apiKey: 'test', model: 'test', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' }, fetcher, observe);
    const result = await provider.generateExplanations!(source, candidates, new AbortController().signal);
    assert.deepEqual(captured, [draft()]);
    assert.ok(!JSON.stringify(captured).includes('providerSecret'));
    assert.ok(!JSON.stringify(result).includes('changes'));
    bad = true;
    await assert.rejects(provider.generateExplanations!(source, candidates, new AbortController().signal), e => invalid(e) && !String(e).includes('sensitive'));
    assert.equal(calls, 2);
  }
});

test('compact provider schema has no reference indices and local bounds reject excessive changes and notes', () => {
  const shape = explanationResponseSchema(candidates).properties.explanations.items;
  assert.deepEqual(shape.required, ['candidateId', 'changes', 'notes']);
  assert.ok(!('maxItems' in shape.properties.changes));
  assert.throws(() => render({ ...draft(), changes: Array(13).fill(draft().changes[0]) }), stage('schema'));
  assert.throws(() => render({ ...draft(), notes: Array(3).fill({ text: '자료', reason: '확인' }) }), stage('schema'));
});
