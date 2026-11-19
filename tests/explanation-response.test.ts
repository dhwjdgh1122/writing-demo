import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderExplanationResponse } from '../server/llm/explanation-response.js';
import { explanationQuotesMatch, explanationProseError } from '../server/llm/explanation-check.js';
import { spacingOnlyExplanation } from '../server/llm/explanation-spacing.js';
import { createGeminiProvider } from '../server/llm/gemini.js';
import { createEliceProvider } from '../server/llm/elice.js';
import { ProviderError } from '../server/llm/provider.js';

// Synthetic minimal regression derived from the Nov 19 report, not a model run.
const source = '세상에서 하나였다.';
const candidates = [{ id: 'one', text: '세상에서 유일했다.' }];
const draft = {
  candidateId: 'one', references: [{ before: '하나였다', after: '유일했다' }],
  explanation: '유일하다는 하나뿐임을 나타내는 말입니다. 문맥에 맞는 표현인지 확인해주세요.',
};
const render = (entry: unknown) => renderExplanationResponse(source, candidates, { explanations: [entry] });

test('space-only descriptions count changed positions, including equal-total moves and Unicode text', () => {
  for (const [before, after, expected] of [
    ['자료를보내주세요.', '자료를 보내 주세요.', '공백 2개를 추가했습니다.'],
    ['자료를  보내 주세요.', '자료를 보내주세요.', '공백 2개를 삭제했습니다.'],
    ['아버지가 방에 들어간다.', '아버지 가방에 들어간다.', '공백 1개를 추가하고 1개를 삭제했습니다.'],
    [' 🌊자료\n다음 줄 ', '🌊 자료\n다음 줄', '공백 1개를 추가하고 2개를 삭제했습니다.'],
    ['회의를\r\n시작 합니다.', '회의를\r\n시작합니다.', '공백 1개를 삭제했습니다.'],
    ['1 5명', '15명', '공백 1개를 삭제했습니다.'],
  ]) {
    const text = spacingOnlyExplanation(before, after);
    assert.equal(text, `${expected} 원문 비교에서 단어가 나뉜 위치가 의도에 맞는지 확인해 주세요.`);
    assert.doesNotMatch(text!, /의미가 같|의미가 유지|정중|올바르|맞춤법|명확/);
  }
});

test('spelling, numeric, punctuation, line break and non-ASCII whitespace changes never use the space-only path', () => {
  for (const [before, after] of [
    ['보내 주세여.', '보내주세요.'], ['15명', '30명'], ['승인되면', '승인 여부와 관계없이'],
    ['안녕', '안녕!'], ['안녕', '안녕'], ['회의\n시작', '회의 시작'], ['회의\r\n시작', '회의\n시작'],
    ['회의\t시작', '회의 시작'], ['회의\u00a0시작', '회의 시작'], ['가', '\u1100\u1161'], [' ', '  '],
  ]) assert.equal(spacingOnlyExplanation(before, after), undefined);
});

test('space-only candidate ignores invented model claims but does not hide sibling or ID failures', () => {
  const original = '목요일에 자료를 보내 주세요.';
  const options = [{ id: 'spacing', text: '목요일에 자료를 보내주세요.' }, { id: 'date', text: '이후에 자료를 보내 주세요.' }];
  const response = renderExplanationResponse(original, options, { explanations: [
    { candidateId: 'spacing', explanation: '날짜를 바꿔 더 정중해졌습니다.', references: [] },
    { candidateId: 'date', explanation: '틀린 인용', references: [{ before: '금요일', after: '이후' }] },
  ] });
  assert.equal(response[0].candidateId, 'spacing');
  assert.ok('explanation' in response[0] && response[0].explanation.startsWith('공백 1개를 삭제했습니다.'));
  assert.deepEqual(response[1], { candidateId: 'date', error: 'EXPLANATION_QUOTE_MISMATCH' });
  assert.throws(() => renderExplanationResponse(original, options, { explanations: [{ candidateId: 'spacing' }] }), ProviderError);
  assert.throws(() => renderExplanationResponse(original, options, { explanations: [{ candidateId: 'spacing' }, { candidateId: 'spacing' }] }), ProviderError);
});

test('reported multiline quotes are consumed as spans, not as the particle between quotes', () => {
  const report = JSON.parse(readFileSync(new URL('./fixtures/explanation-reported-multiline.json', import.meta.url), 'utf8'));
  assert.equal(explanationQuotesMatch(report.sourceText, report.candidate.text, report.reportedExplanation), true);
  // Fixing the final guard does not relax the current adapter's single-line prose contract.
  assert.equal(explanationProseError(report.sourceText, report.candidate.text, report.reportedExplanation), 'EXPLANATION_INVALID');
  const results = renderExplanationResponse(report.sourceText, [report.candidate], { explanations: [{
    candidateId: report.candidate.id,
    references: [{ before: '조~빠\n십게', after: '조~빠\n쉽게' }],
    explanation: '십게를 쉽게로 고쳤습니다.',
  }] });
  assert.ok('explanation' in results[0]);
  assert.equal(explanationQuotesMatch(report.sourceText, report.candidate.text, results[0].explanation), true);
});

test('all quote styles check exact multiline content instead of skipping or normalizing it', () => {
  for (const [open, close] of [["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”'], ['「', '」'], ['『', '』'], ['`', '`']]) {
    for (const newline of ['\n', '\r\n']) {
      const before = `회의를${newline}시작합니다`;
      const after = `회의를${newline}진행합니다`;
      const text = `${open}${before}${close}가 ${open}${after}${close}로 바뀌었습니다.`;
      assert.equal(explanationQuotesMatch(before, after, text), true);
      assert.equal(explanationQuotesMatch(before, after, text.replace('진행합니다', '종료합니다')), false);
      assert.equal(explanationQuotesMatch(before, after, text.replaceAll(newline, ' ')), false);
      assert.equal(explanationQuotesMatch(before, after, text.replace(newline, newline === '\n' ? '\r\n' : '\n')), false);
    }
  }
});

test('preserved teammate output reproduces the exact quote rejection without a model call', () => {
  const report = JSON.parse(readFileSync(new URL('./fixtures/explanation-reported-quote.json', import.meta.url), 'utf8'));
  assert.equal(explanationQuotesMatch(report.sourceText, report.candidate.text, report.reportedExplanation), false);
  assert.equal(explanationQuotesMatch(report.sourceText, report.candidate.text, report.reportedExplanation.replace('‘유일하다’', '‘유일했다’')), true);
  // This diagnostic replacement is NOT a product repair or a correct explanation.
  assert.deepEqual(renderExplanationResponse(report.sourceText, [report.candidate], { explanations: [
    { candidateId: report.candidate.id, explanation: report.reportedExplanation },
  ] }), [{ candidateId: report.candidate.id, error: 'EXPLANATION_INVALID' }]);
});

test('reported basic-form quote still fails; exact evidence plus unquoted word explanation can be displayed', () => {
  assert.equal(explanationQuotesMatch(source, candidates[0].text, '‘하나였다’를 ‘유일하다’로 바꿨습니다.'), false);
  const result = render(draft)[0];
  assert.ok('explanation' in result);
  assert.match(result.explanation, /‘하나였다’ → ‘유일했다’/);
  assert.match(result.explanation, /유일하다는/);
  assert.equal(explanationQuotesMatch(source, candidates[0].text, result.explanation), true);
  assert.deepEqual(render({ ...draft, references: [{ before: '하나였다', after: '유일하다' }] }), [
    { candidateId: 'one', error: 'EXPLANATION_QUOTE_MISMATCH' },
  ]);
});

test('evidence remains exact and directional; other candidates never justify a quotation', () => {
  for (const references of [
    [{ before: '유일했다', after: '하나였다' }],
    [{ before: '하나 였다', after: '유일했다' }],
    [{ before: '하나였다', after: '유일\n했다' }],
  ]) assert.deepEqual(render({ ...draft, references }), [{ candidateId: 'one', error: 'EXPLANATION_QUOTE_MISMATCH' }]);
  const results = renderExplanationResponse(source, [...candidates, { id: 'two', text: '유일하다' }], { explanations: [
    { ...draft, references: [{ before: '하나였다', after: '유일하다' }] },
    { candidateId: 'two', references: [{ before: source, after: '유일하다' }], explanation: '시제가 바뀌었습니다.' },
  ] });
  assert.deepEqual(results[0], { candidateId: 'one', error: 'EXPLANATION_QUOTE_MISMATCH' });
  assert.ok('explanation' in results[1]);
});

test('invalid prose, empty or duplicated evidence and excessive rendered length fail only their candidate', () => {
  for (const entry of [
    { ...draft, explanation: ' ' }, { ...draft, explanation: '가'.repeat(401) },
    { ...draft, explanation: '가'.repeat(390) }, // Evidence also counts toward the 400-character limit.
    { ...draft, explanation: '‘유일했다라는 뜻입니다.' },
    { ...draft, explanation: '첫째\n둘째' },
    { ...draft, references: [] }, { ...draft, references: [{ before: '', after: '' }] },
    { ...draft, references: [{ before: '세상', after: '세상' }] },
    { ...draft, references: [...draft.references, ...draft.references] },
    { candidateId: 'one', explanation: '이전 자유문 형식' },
  ]) assert.deepEqual(render(entry), [{ candidateId: 'one', error: 'EXPLANATION_INVALID' }]);
});

test('exact prose quotations survive unchanged; invented or other-candidate quotations do not', () => {
  for (const [open, close] of [["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”'], ['「', '」'], ['『', '』'], ['`', '`']]) {
    const explanation = `${open}하나였다${close}를 ${open}유일했다${close}로 바꿨습니다.`;
    const result = render({ ...draft, explanation })[0];
    assert.ok('explanation' in result && result.explanation.endsWith(explanation));
  }
  for (const explanation of ['‘유일하다’라는 뜻입니다.', '‘하나 였다’를 수정했습니다.', '‘없는 말’을 고쳤습니다.']) {
    assert.deepEqual(render({ ...draft, explanation }), [{ candidateId: 'one', error: 'EXPLANATION_QUOTE_MISMATCH' }]);
  }
  const result = renderExplanationResponse(source, [...candidates, { id: 'two', text: '유일하다' }], { explanations: [
    { ...draft, explanation: '‘유일하다’로 수정했습니다.' },
    { candidateId: 'two', references: [{ before: source, after: '유일하다' }], explanation: '‘유일하다’로 바뀌었습니다.' },
  ] });
  assert.deepEqual(result[0], { candidateId: 'one', error: 'EXPLANATION_QUOTE_MISMATCH' });
  assert.ok('explanation' in result[1]);
});

test('unclosed, mismatched, nested, blank and multiline prose quotes fail rather than bypass matching', () => {
  for (const prose of ['‘유일했다', '유일했다’', '‘유일했다"', "'유일했다", '‘ ’', '‘유일\n했다’',
    '‘“유일했다”’', '‘유일했다’ 뒤의 ‘열린 인용', '‘없는 구절’ 뒤의 ‘열린 인용']) {
    assert.equal(explanationProseError(source, candidates[0].text, prose), 'EXPLANATION_INVALID');
  }
  assert.equal(explanationProseError('회의를\n시작합니다', '회의를\n진행합니다', '‘회의를 진행합니다’로 변경'), 'EXPLANATION_QUOTE_MISMATCH');
  // Exact words alone cannot validate a false account of the change.
  assert.equal(explanationProseError(source, candidates[0].text, '‘유일했다’가 두 사람이라는 뜻입니다.'), undefined);
});

test('unknown, missing or duplicate candidate IDs remain whole-response errors', () => {
  for (const decoded of [null, { explanations: [] }, { explanations: [draft, draft] },
    { explanations: [{ ...draft, candidateId: 'foreign' }] }, { explanations: [draft], extra: true },
  ]) assert.throws(() => renderExplanationResponse(source, candidates, decoded), e => e instanceof ProviderError && e.kind === 'invalid');
});

test('insertions, deletions, multiline evidence and unchanged candidates retain their text', () => {
  const result = renderExplanationResponse('안녕\n친구', [
    { id: 'same', text: '안녕\n친구' }, { id: 'add', text: '안녕\n친구!' }, { id: 'delete', text: '안녕' },
  ], { explanations: [
    { candidateId: 'same' },
    { candidateId: 'add', references: [{ before: '', after: '!' }], explanation: '감탄을 표시했습니다.' },
    { candidateId: 'delete', references: [{ before: '\n친구', after: '' }], explanation: '대상을 나타내는 표현이 빠졌습니다.' },
  ] });
  assert.deepEqual(result, [
    { candidateId: 'same', explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' },
    { candidateId: 'add', explanation: '‘!’ 추가. 감탄을 표시했습니다.' },
    { candidateId: 'delete', explanation: '‘\n친구’ 삭제. 대상을 나타내는 표현이 빠졌습니다.' },
  ]);
});

test('passing structural checks is not a semantic quality verdict', () => {
  const result = render({ ...draft, explanation: '완전히 다른 뜻이므로 반드시 이 후보를 사용해야 합니다.' });
  assert.ok('explanation' in result[0]); // Deliberately poor prose: must be reviewed separately.
});

for (const name of ['gemini', 'elice'] as const) {
  test(`${name}: one upstream call returns mixed results, and all-invalid drafts remain explicit failures`, async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      const value = { explanations: [draft, { ...draft, candidateId: 'two', references: [{ before: '하나였다', after: '없는 인용' }] }] };
      const text = JSON.stringify(value);
      return Response.json(name === 'gemini'
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: text } }] });
    };
    const provider = name === 'gemini'
      ? createGeminiProvider({ apiKey: 'fake-test-key', model: 'gemini-test' }, fetcher)
      : createEliceProvider({ apiKey: 'fake-test-key', model: 'gpt-4o-mini', baseUrl: 'https://mlapi.run/40cc17ae-a89b-4f12-a7d6-13293180fc87' }, fetcher);
    const result = await provider.generateExplanations!(source, [...candidates, { id: 'two', text: '하나뿐이었다.' }], new AbortController().signal);
    assert.deepEqual(result, [...render(draft), { candidateId: 'two', error: 'EXPLANATION_QUOTE_MISMATCH' }]);
    assert.equal(calls, 1);
    const allFailed = await provider.generateExplanations!('다른 원문', [...candidates, { id: 'two', text: '하나뿐이었다.' }], new AbortController().signal);
    assert.deepEqual(allFailed, [{ candidateId: 'one', error: 'EXPLANATION_QUOTE_MISMATCH' }, { candidateId: 'two', error: 'EXPLANATION_QUOTE_MISMATCH' }]);
    assert.equal(calls, 2); // One explicit request each; no automatic retries.
  });
}
