import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareNumberSpellings, formatNumberSpellings } from '../client/src/lib/numeric-comparison.js';

test('shows literal counts independently of missing or wrong model explanations', () => {
  assert.deepEqual(compareNumberSpellings('확인되면 화요일까지 8명에게 보낼 예정입니다.', '화요일까지 10명에게 발송합니다.'), {
    source: [{ text: '8', count: 1 }], candidate: [{ text: '10', count: 1 }],
  });
  assert.deepEqual(compareNumberSpellings('8명 중 2명에게 안내합니다.', '8명에게 안내합니다.'), {
    source: [{ text: '2', count: 1 }], candidate: [],
  });
  assert.deepEqual(compareNumberSpellings('자료를 보냅니다.', '15명에게 자료를 보냅니다.'), {
    source: [], candidate: [{ text: '15', count: 1 }],
  });
});

test('does not equate formatting with quantities, drop leading zeros or split decimals', () => {
  for (const [before, after] of [['1,000', '1000'], ['08', '8'], ['1.5', '15'], ['3,50', '3.50']]) {
    assert.deepEqual(compareNumberSpellings(before, after), {
      source: [{ text: before, count: 1 }], candidate: [{ text: after, count: 1 }],
    });
  }
});

test('preserves repeated spellings and never invents replacement pairing', () => {
  const result = compareNumberSpellings('8명과 8명에게 2개씩', '8명에게 3개씩');
  assert.deepEqual(result, { source: [{ text: '8', count: 2 }, { text: '2', count: 1 }], candidate: [{ text: '8', count: 1 }, { text: '3', count: 1 }] });
  assert.equal(formatNumberSpellings(result!.source), '8 (2회) / 2');
  assert.equal(formatNumberSpellings([]), '없음');
});

test('same digits do not certify preserved roles, units, signs, conditions or number words', () => {
  for (const [before, after] of [
    ['A는 8명, B는 10명', 'A는 10명, B는 8명'], ['8명', '8개'], ['-8', '8'],
    ['승인되면 8명', '8명'], ['열 명', '여덟 명'], ['회원인 경우에만', '회원만'],
  ]) assert.equal(compareNumberSpellings(before, after), null);
});

test('large lists or long digit sequences fall back without a truncated summary', () => {
  assert.equal(compareNumberSpellings('1 2 3 4', '5 6 7 8'), null);
  assert.equal(compareNumberSpellings('1'.repeat(25), '2'), null);
  assert.equal(compareNumberSpellings(' '.repeat(1000), '안내'), null);
});

test('each displayed spelling has exact source counts and changed counts on its own side', () => {
  const result = compareNumberSpellings('8명 18명 8명\n1,000원', '18명 10명\n1000원')!;
  assert.deepEqual(result.source, [{ text: '8', count: 2 }, { text: '1,000', count: 1 }]);
  assert.deepEqual(result.candidate, [{ text: '10', count: 1 }, { text: '1000', count: 1 }]);
});

test('saved E-03 failures expose 8 versus 10 without changing or grading model prose', () => {
  let checked = 0;
  for (const file of [
    'final-gate-gemini-2026-11-19T10-14-54-775Z.json',
    'final-gate-elice-2026-11-19T10-14-54-002Z.json',
    'focused-gate-gemini-2026-11-19T10-34-11-433Z.json',
    'focused-gate-elice-2026-11-19T10-34-13-605Z.json',
  ]) {
    const report = JSON.parse(readFileSync(new URL(`../docs/evaluations/${file}`, import.meta.url), 'utf8'));
    for (const run of report.runs.filter((r: { caseId: string }) => r.caseId === 'E-03')) {
      const response = run.response;
      assert.ok(response.explanations[0].explanation);
      const before = JSON.stringify(response);
      assert.deepEqual(compareNumberSpellings(response.sourceText, response.candidates[0].text), {
        source: [{ text: '8', count: 1 }], candidate: [{ text: '10', count: 1 }],
      });
      assert.equal(JSON.stringify(response), before);
      checked++;
    }
  }
  assert.equal(checked, 6); // Repetitions of one synthetic case, not six independent users.
});
