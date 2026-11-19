import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alignSpaces, auditSpacingClaim } from '../scripts/lib/explanation-spacing-audit.mjs';

test('alignment distinguishes actual space edits from shifts caused by other character edits', () => {
  for (const [a,b] of [['보내 주세여.','보내 주세요.'], ['자료 보내요','자료를 보내요'], ['😀 자료 요청','😀😀 자료 요청'],
    ['금요일 13명','일요일 30명'], ['', ''], ['가 나','가 나']]) assert.equal(alignSpaces(a,b).status,'preserved',`${a} -> ${b}`);
  for (const [a,b] of [['보내 주세여.','보내주세요.'], ['자료를보내요','자료를 보내요'], ['가  나','가 나'],
    ['1 5명','15명']]) assert.equal(alignSpaces(a,b).status,'changed',`${a} -> ${b}`);
});

test('ambiguous minimum alignments and unsupported inputs abstain, rather than trusting one diff path', () => {
  assert.equal(alignSpaces('가 ',' 가').status,'ambiguous');
  // A space move and deleting/inserting 가 around an unchanged space both cost 2.
  // A single chosen alignment would conceal this ambiguity.
  assert.equal(alignSpaces('아버지가 방','아버지 가방').status,'ambiguous');
  for (const separator of ['\n','\r\n','\t','\u00a0','\u3000'])
    assert.equal(alignSpaces('가'+separator+'나','가'+separator+'다').status,'unsupported-whitespace');
  assert.equal(alignSpaces('가'.repeat(1001),'가').status,'comparison-limit');
  assert.equal(alignSpaces('가'.repeat(1000),'나'.repeat(2000)).status,'comparison-limit');
});

test('negated, advisory, quoted, hypothetical and malformed claims do not become contradictions', () => {
  const source='보내 주세여.', candidate='보내 주세요.';
  for (const prose of ['띄어쓰기를 수정하지 않았습니다.', '띄어쓰기를 수정할 필요가 없습니다.',
    '띄어쓰기를 수정했습니다라는 설명은 잘못됐습니다.', '예시: 띄어쓰기를 수정했습니다.',
    '만약 띄어쓰기를 수정했습니다.', '띄어쓰기를 수정했습니다. 그렇지 않습니다.',
    '띄어쓰기를 수정했습니다?', '‘띄어쓰기를 수정했습니다.’', '“띄어쓰기를 수정했습니다.',
    '띄어쓰기를 수정했습니다”', '공백을 추가했습니다.', '오타를 고쳤습니다.'])
    assert.notEqual(auditSpacingClaim(source,candidate,prose).verdict,'review-needed',prose);
  for (const [open,close] of [["'","'"],['"','"'],['‘','’'],['“','”'],['「','」'],['『','』'],['`','`']])
    assert.notEqual(auditSpacingClaim(source,candidate,open+'띄어쓰기를 수정했습니다.'+close).verdict,'review-needed');
});

test('supported contradictions are review findings; real changes, ambiguity and unrecognized claims never imply quality success', () => {
  for (const ending of ['수정했습니다.','교정하였습니다.','변경했다'])
    assert.equal(auditSpacingClaim('보내 주세여.','보내 주세요.','오탈자를 바로잡고 띄어쓰기를 '+ending).verdict,'review-needed');
  assert.equal(auditSpacingClaim('보내 주세여.','보내주세요.','띄어쓰기를 수정했습니다.').verdict,'not-covered');
  assert.equal(auditSpacingClaim('가 ',' 가','띄어쓰기를 수정했습니다.').verdict,'abstained');
  assert.equal(auditSpacingClaim('금요일','일요일','같은 뜻입니다.').verdict,'not-covered');
});

test('stored Gemini false spacing statement is detected, while the adjacent real spacing change is not flagged', () => {
  const report=JSON.parse(readFileSync(new URL('../docs/evaluations/impact-fields-gemini-2026-11-19T08-34-19-860Z.json',import.meta.url),'utf8'));
  const c=report.cases.find(c=>c.id==='P-04'), run=report.runs.find(r=>r.caseId===c.id);
  for(const candidate of c.candidates) {
    const explanation=run.response.explanations.find(e=>e.candidateId===candidate.id).explanation;
    assert.equal(auditSpacingClaim(c.sourceText,candidate.text,explanation).verdict,candidate.id==='spaced'?'review-needed':'not-covered');
  }
});
