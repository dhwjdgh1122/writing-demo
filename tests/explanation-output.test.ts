import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainCandidates } from '../server/llm/explain-candidates.js';
import { renderExplanations, renderSingleExplanation, explanationResponseSchema } from '../server/llm/explanation-output.js';
import { ProviderError } from '../server/llm/provider.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';

const source = '자료를 확인한후 연락해 주세요.';
const candidates = [{ id: 'one', text: '자료를 확인한 후 연락해 주세요.' }];
const draft = () => ({ candidateId: 'one', changes: [{ kind: 'spacing', before: '확인한후', after: '확인한 후', effect: '' }], notes: [] });
const render = (value: unknown) => renderExplanations(source, candidates, { explanations: [value] })[0].explanation;
const invalid = (error: unknown) => error instanceof ProviderError && error.kind === 'invalid';
const stage = (expected: string) => (error: unknown) => invalid(error) && (error as ProviderError).validationFailure === expected;

test('schema diagnostics locate invalid fields without retaining values, unknown keys or validator messages', () => {
  const decoded = { notes: [], surfaceChanges: [], meaningChanges: [
    { kind: 'private-model-value', before: 'secret-source', after: 'secret-candidate', unexpectedPrivateKey: 'secret-token' },
  ] };
  assert.throws(() => renderSingleExplanation(source, candidates[0], decoded), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.validationFailure, 'schema');
    assert.deepEqual(error.schemaDiagnostics, [
      { path: ['meaningChanges', 0, 'kind'], code: 'invalid_value' },
      { path: ['meaningChanges', 0, 'effect'], code: 'invalid_type' },
      { path: ['meaningChanges', 0], code: 'unrecognized_keys', extraFields: ['[unknown]'] },
    ]);
    const saved = JSON.stringify(error);
    for (const value of ['private-model-value','secret-source','secret-candidate','unexpectedPrivateKey','secret-token']) assert.ok(!saved.includes(value));
    return true;
  });
});

test('diagnostics identify forbidden known fields and are bounded without changing rejection', () => {
  const change = { kind: 'spacing', before: '확인한후', after: '확인한 후', effect: 'not permitted' };
  assert.throws(() => renderSingleExplanation(source, candidates[0], { notes: [], surfaceChanges: [change], meaningChanges: [] }), error => {
    assert.ok(error instanceof ProviderError);
    assert.deepEqual(error.schemaDiagnostics, [{ path: ['surfaceChanges', 0], code: 'unrecognized_keys', extraFields: ['effect'] }]);
    return true;
  });
  assert.throws(() => renderSingleExplanation(source, candidates[0], {
    notes: [], surfaceChanges: Array(12).fill({ kind: 'invalid', before: null, after: null }), meaningChanges: [],
  }), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.schemaDiagnostics?.length,20);
    return true;
  });
});

test('split wire contract preserves meaningful effects, surface labels and remaining-usage notes', () => {
  const before = '등록비를 결재한 8명에게 보냇습니다.';
  const candidate = { id: 'one', text: '등록비를 결재한 10명에게 보냈습니다.' };
  const decoded = {
    notes: [{ text: '결재', reason: '등록비 납부 문맥에 맞는 단어가 필요합니다' }],
    surfaceChanges: [{ kind: 'spelling', before: '보냇습니다', after: '보냈습니다' }],
    meaningChanges: [{ kind: 'quantity', before: '8명', after: '10명', effect: '자료를 받는 인원이 늘어납니다' }],
  };
  let observed: unknown;
  const result = renderSingleExplanation(before, candidate, decoded, rows => { observed = rows; });
  assert.equal(result.candidateId, 'one');
  assert.ok(result.explanation.startsWith('‘8명’ → ‘10명’: 자료를 받는 인원이 늘어납니다'));
  assert.ok(result.explanation.includes('‘보냇습니다’ → ‘보냈습니다’: 맞춤법·오탈자 수정'));
  assert.ok(result.explanation.includes('남아 있는 ‘결재’ 표현'));
  assert.ok(result.explanation.includes('수치·인원 정보를 유지'));
  assert.deepEqual(observed, [{ candidateId: 'one', notes: decoded.notes,
    changes: [...decoded.meaningChanges, { ...decoded.surfaceChanges[0], effect: '' }] }]);
});

test('split contract rejects wrong categories, extra surface prose and missing meaning effects without repairing output', () => {
  const surface = { kind: 'spacing', before: '확인한후', after: '확인한 후' };
  const run = (decoded: unknown) => renderSingleExplanation(source, candidates[0], decoded);
  const valid = { notes: [], surfaceChanges: [surface], meaningChanges: [] };
  assert.equal(run(valid).explanation, render(draft()));
  for (const decoded of [
    { ...valid, surfaceChanges: [{ ...surface, effect: '' }] },
    { ...valid, surfaceChanges: [{ ...surface, effect: '날짜가 바뀝니다' }] },
    { ...valid, surfaceChanges: [{ ...surface, kind: 'date' }] },
    { notes: [], surfaceChanges: [], meaningChanges: [{ ...surface, kind: 'date' }] },
    { notes: [], surfaceChanges: [], meaningChanges: [{ ...surface, effect: '설명' }] },
    { changes: [draft().changes[0]], notes: [] },
  ]) assert.throws(() => run(decoded), stage('schema'));
  assert.throws(() => run({ notes: [], surfaceChanges: [], meaningChanges: [{ ...surface, kind: 'date', effect: '' }] }), stage('change'));
});

test('split wire bounds cover combined changes and notes before exposing normalized drafts', () => {
  const surface = { kind: 'spacing', before: '확인한후', after: '확인한 후' };
  const meaning = { kind: 'date', before: '확인한후', after: '확인한 후', effect: '주장' };
  let observed = false;
  for (const decoded of [
    { notes: [], surfaceChanges: Array(7).fill(surface), meaningChanges: Array(6).fill(meaning) },
    { notes: Array(3).fill({ text: '자료', reason: '설명' }), surfaceChanges: [surface], meaningChanges: [] },
  ]) assert.throws(() => renderSingleExplanation(source, candidates[0], decoded, () => { observed = true; }), stage('schema'));
  assert.equal(observed, false);
});

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
      const decoded = { surfaceChanges: [{ kind: 'spacing', before: bad ? 'sensitive invented content' : '확인한후', after: '확인한 후' }], meaningChanges: [], notes: [] };
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
  const shape = explanationResponseSchema();
  assert.deepEqual(shape.required, ['notes', 'surfaceChanges', 'meaningChanges']);
  assert.ok(!('maxItems' in shape.properties.surfaceChanges));
  assert.throws(() => render({ ...draft(), changes: Array(13).fill(draft().changes[0]) }), stage('schema'));
  assert.throws(() => render({ ...draft(), notes: Array(3).fill({ text: '자료', reason: '확인' }) }), stage('schema'));
});

test('both adapters isolate each candidate, bind IDs on the server, and keep observations across calls', async () => {
  for (const name of ['gemini', 'elice']) {
    const inputs: unknown[] = [], observed: unknown[] = [], attempted: string[] = [];
    let active = 0;
    const fetcher: typeof fetch = async (_url, options) => {
      assert.equal(++active, 1, 'requests must be sequential');
      const body = JSON.parse(String(options?.body));
      const input = JSON.parse(name === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content);
      inputs.push(input);
      assert.deepEqual(Object.keys(input).sort(), ['candidate', 'sourceText']);
      assert.deepEqual(Object.keys(input.candidate).sort(), ['comparison', 'text']);
      const decoded = { surfaceChanges: [{ kind: 'wording', before: '원문', after: input.candidate.text }], meaningChanges: [], notes: [] };
      await Promise.resolve();
      active--;
      return Response.json(name === 'gemini'
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(decoded) }] } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decoded) } }] });
    };
    const observer = (rows: unknown[]) => { observed.push(...rows); };
    const callObserver = (id: string) => { attempted.push(id); };
    const provider = name === 'gemini'
      ? createGeminiProvider({ apiKey: 'test', model: 'gemini-test' }, fetcher, observer, callObserver)
      : createEliceProvider({ apiKey: 'test', model: 'test', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' }, fetcher, observer, callObserver);
    const candidates = [{ id: 'alpha', text: '후보 하나' }, { id: 'same', text: '원문' }, { id: 'beta', text: '다른 후보' }];
    const result = await provider.generateExplanations!('원문', candidates, new AbortController().signal) as { candidateId: string }[];
    assert.deepEqual(result.map(r => r.candidateId), ['alpha', 'same', 'beta']);
    assert.deepEqual(attempted, ['alpha', 'beta']);
    assert.equal(observed.length, 2);
    assert.ok(!JSON.stringify(inputs[0]).includes('다른 후보'));
    assert.ok(!JSON.stringify(inputs[1]).includes('후보 하나'));
  }
});

test('isolated explanation failure stops later candidates and never returns partial success', async () => {
  const candidates = [{ id: 'a', text: '가' }, { id: 'b', text: '나' }, { id: 'c', text: '다' }];
  for (const mode of ['schema', 'reference', 'unavailable'] as const) {
    let calls = 0; const observed: unknown[] = [], attempts: string[] = [];
    const pending = explainCandidates('원문', candidates, new AbortController().signal, async input => {
      calls++;
      if (calls === 2 && mode === 'unavailable') throw new ProviderError('unavailable');
      if (calls === 2 && mode === 'schema') return { changes: [], notes: [], candidateId: 'injected' };
      return { surfaceChanges: [{ kind: 'wording', before: calls === 2 ? '없는 원문' : '원문', after: input.candidate.text }], meaningChanges: [], notes: [] };
    }, rows => { observed.push(...rows); }, id => { attempts.push(id); });
    await assert.rejects(pending, e => e instanceof ProviderError && (mode === 'unavailable' ? e.kind === mode : e.validationFailure === mode));
    assert.equal(calls, 2);
    assert.deepEqual(attempts, ['a', 'b']);
    assert.equal(observed.length, mode === 'reference' ? 2 : 1);
  }
});

test('identical candidates need no model call and invalid batches are rejected before spending calls', async () => {
  let calls = 0;
  const generate = async () => { calls++; throw new Error('should not call'); };
  const run = (candidates: { id: string; text: string }[]) => explainCandidates('원문', candidates, new AbortController().signal, generate);
  assert.equal((await run([{ id: 'same', text: '원문' }]))[0].explanation, '원문과 동일하여 변경된 표현이나 의미가 없습니다.');
  for (const candidates of [[], ['a', 'b', 'c', 'd'].map(id => ({ id, text: '후보' })), [{ id: 'a', text: '가' }, { id: 'a', text: '나' }]]) {
    await assert.rejects(run(candidates), invalid);
  }
  assert.equal(calls, 0);
});

test('shared cancellation prevents later calls, including when an upstream ignores abort', async () => {
  const controller = new AbortController(); let calls = 0;
  const run = () => explainCandidates('원문', [{ id: 'a', text: '가' }, { id: 'b', text: '나' }], controller.signal, async () => {
    calls++; controller.abort();
    return { surfaceChanges: [{ kind: 'wording', before: '원문', after: '가' }], meaningChanges: [], notes: [] };
  });
  await assert.rejects(run(), { name: 'AbortError' });
  await assert.rejects(run(), { name: 'AbortError' });
  assert.equal(calls, 1);
});
