import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spacingOnlyExplanation } from '../server/llm/explanation-spacing.js';
import { parseExplanations } from '../server/llm/parse-explanations.js';
import { explanationQuotesMatch } from '../server/llm/explanation-check.js';
import { ProviderError } from '../server/llm/provider.js';
import pilotCases from './fixtures/explanation-continuation-pilot-2026-11-22.json';

const guidance = ' 원문 비교에서 공백이 바뀐 위치가 의도에 맞는지 확인해 주세요.';

test('spacing facts count U+0020 characters at each gap, including moves and unchanged Unicode/newlines', () => {
  for (const [before, after, expected] of [
    ['자료를보내주세요.', '자료를 보내 주세요.', '공백 2개를 추가했습니다.'],
    ['자료를   보내 주세요.', '자료를 보내주세요.', '공백 3개를 삭제했습니다.'],
    ['아버지가 방에 들어간다.', '아버지 가방에 들어간다.', '공백 1개를 추가하고 1개를 삭제했습니다.'],
    [' 🌊자료\n다음 줄 ', '🌊 자료\n다음 줄', '공백 1개를 추가하고 2개를 삭제했습니다.'],
    ['회의를\r\n시작 합니다.', '회의를\r\n시작합니다.', '공백 1개를 삭제했습니다.'],
    ['1 5명', '15명', '공백 1개를 삭제했습니다.'],
    ['가  ', '가', '공백 2개를 삭제했습니다.'],
  ]) {
    const actual = spacingOnlyExplanation(before, after);
    assert.equal(actual, expected + guidance);
    assert.doesNotMatch(actual!, /의미가 같|의미가 유지|정중|올바르|맞춤법|명확/);
  }
});

test('any non-U+0020 change or unchanged/empty text stays outside the spacing path', () => {
  for (const [before, after] of [
    ['보내 주세여.', '보내주세요.'], ['15명', '30명'], ['승인되면', '승인 여부와 관계없이'],
    ['안녕', '안녕!'], ['안녕', '안녕'], ['', ' '], [' ', '  '],
    ['회의\n시작', '회의 시작'], ['회의\r\n시작', '회의\n시작'],
    ['회의\t시작', '회의 시작'], ['회의\u00a0시작', '회의 시작'],
    ['회의\u3000시작', '회의 시작'], ['가', '\u1100\u1161'],
  ]) assert.equal(spacingOnlyExplanation(before, after), undefined, JSON.stringify([before, after]));
});

test('mixed candidates replace only spacing speculation and preserve other normal/invalid-quote prose', () => {
  const source = '목요일에 자료를 보내 주세요.';
  const candidates = [
    { id: 'spacing', text: '목요일에 자료를 보내주세요.' },
    { id: 'normal', text: '금요일에 자료를 보내 주세요.' },
    { id: 'quote', text: '이후에 자료를 보내 주세요.' },
  ];
  const normal = { candidateId: 'normal', explanation: '목요일에서 금요일로 안내 날짜가 바뀌었습니다.' };
  const quote = { candidateId: 'quote', explanation: '‘수요일’에서 ‘이후’로 바뀌었습니다.' };
  const result = parseExplanations(source, candidates, { explanations: [
    { candidateId: 'spacing', explanation: '날짜를 바꿔 더 정중해졌습니다.' }, normal, quote,
  ] });
  assert.deepEqual(result, [
    { candidateId: 'spacing', explanation: '공백 1개를 삭제했습니다.' + guidance }, normal, quote,
  ]);
  // The API's existing final quote guard still rejects only the bad sibling;
  // this parser must not normalize its quote or fabricate a replacement.
  assert.equal(explanationQuotesMatch(source, candidates[1].text, normal.explanation), true);
  assert.equal(explanationQuotesMatch(source, candidates[2].text, quote.explanation), false);
});

test('spacing can replace malformed model items without hiding sibling format failures', () => {
  const source = '자료를 보내 주세요.';
  const candidates = [{ id: 'spacing', text: '자료를 보내주세요.' }, { id: 'other', text: '자료를 주십시오.' }];
  for (const malformed of [{}, { explanation: '' }, { explanation: 5 }, { explanation: '가'.repeat(401) }, { explanation: '설명', extra: true }]) {
    assert.deepEqual(parseExplanations(source, candidates, { explanations: [
      { candidateId: 'spacing', ...malformed }, { candidateId: 'other', ...malformed },
    ] }), [
      { candidateId: 'spacing', explanation: '공백 1개를 삭제했습니다.' + guidance },
      { candidateId: 'other', error: 'EXPLANATION_INVALID' },
    ]);
  }
});

test('unchanged candidates keep the fixed explanation and existing malformed-item failure', () => {
  const source = '자료를 보내 주세요.';
  const candidates = [{ id: 'same', text: source }];
  assert.deepEqual(parseExplanations(source, candidates, { explanations: [{ candidateId: 'same', explanation: '더 정중합니다.' }] }), [
    { candidateId: 'same', explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' },
  ]);
  assert.deepEqual(parseExplanations(source, candidates, { explanations: [{ candidateId: 'same' }] }), [
    { candidateId: 'same', error: 'EXPLANATION_INVALID' },
  ]);
});

test('reported M-01 only replaces c1 and does not count the mixed candidates as spacing-only', () => {
  const item = pilotCases.find(row => row.id === 'M-01')!;
  const reported = item.reportedExplanations!;
  const result = parseExplanations(item.sourceText, item.candidates, { explanations: reported });
  assert.deepEqual(result[0], { candidateId: 'm01-c1', explanation: '공백 5개를 추가하고 4개를 삭제했습니다.' + guidance });
  assert.deepEqual(result.slice(1), reported.slice(1));
  for (const candidate of item.candidates.slice(1)) assert.equal(spacingOnlyExplanation(item.sourceText, candidate.text), undefined);
});

test('R-03 residual-word case remains model prose, without implying that its explanation is correct', () => {
  const item = pilotCases.find(row => row.id === 'R-03')!;
  const explanation = { candidateId: item.candidates[0].id, explanation: '오타를 수정했습니다.' };
  assert.equal(spacingOnlyExplanation(item.sourceText, item.candidates[0].text), undefined);
  assert.deepEqual(parseExplanations(item.sourceText, item.candidates, { explanations: [explanation] }), [explanation]);
});

test('spacing never bypasses malformed envelopes or missing/duplicate/unknown candidate IDs', () => {
  const source = '자료를 보내 주세요.';
  const candidates = [{ id: 'one', text: '자료를 보내주세요.' }, { id: 'two', text: '자료를보내주세요.' }];
  for (const raw of [
    null, 'not JSON', { explanations: [] }, { explanations: [{ candidateId: 'one' }] },
    { explanations: [{ candidateId: 'one' }, { candidateId: 'one' }] },
    { explanations: [{ candidateId: 'one' }, { candidateId: 'unknown' }] },
    { explanations: [{ candidateId: 'one' }, { candidateId: 'two' }], extra: true },
    { explanations: [{ candidateId: 'one' }, {}] },
  ]) assert.throws(() => parseExplanations(source, candidates, raw), error => error instanceof ProviderError && error.kind === 'invalid');
});
