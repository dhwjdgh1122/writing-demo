import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceInput, resolveEvidence } from '../scripts/lib/explanation-evidence-experiment.mjs';
import { renderExplanationResponse } from '../server/llm/explanation-response.ts';
import { ProviderError } from '../server/llm/provider.ts';

test('experimental evidence preserves exact source/candidate lines and falls back without truncating', () => {
  for (const [source, text] of [
    ['😀 첫 줄\n\n셋째 줄', '😀 첫줄\n\n셋째줄'],
    ['첫 줄\n둘째 줄', '첫 줄 둘째 줄'], ['앞\r\n뒤', '앞\n뒤'],
    ['안녕\n친구', '안녕\n'], ['줄\n'.repeat(13), '행\n'.repeat(13)],
  ]) {
    const input = buildEvidenceInput(source, [{ id: 'one', text }]);
    const evidence = input.candidates[0].evidence;
    assert.ok(evidence.length >= 1 && evidence.length <= 12);
    for (const e of evidence) { assert.ok(source.includes(e.before)); assert.ok(text.includes(e.after)); assert.notEqual(e.before, e.after); }
    if (source.split('\n').length !== text.split('\n').length || source.split('\n').length > 12) {
      assert.equal(evidence[0].before, source); assert.equal(evidence[0].after, text);
    }
  }
});

test('IDs resolve only within their candidate and preserve a valid sibling on partial failure', () => {
  const source = '세상에서 하나였다.';
  const candidates = [{ id: 'one', text: '세상에서 유일했다.' }, { id: 'two', text: '세상에 하나뿐이었다.' }];
  const input = buildEvidenceInput(source, candidates);
  const valid = { candidateId: 'one', evidenceIds: ['c1-e1'], explanation: '하나뿐이라는 뜻을 유지하며 표현을 바꿨습니다.' };
  for (const ids of [[], ['c1-e1'], ['c2-e1', 'c2-e1'], ['missing']]) {
    const mapped = resolveEvidence(input, { explanations: [valid, { candidateId: 'two', evidenceIds: ids, explanation: '표현을 바꿨습니다.' }] });
    const results = renderExplanationResponse(source, candidates, mapped);
    assert.ok('explanation' in results[0]);
    assert.deepEqual(results[1], { candidateId: 'two', error: 'EXPLANATION_INVALID' });
  }
  for (const entries of [[valid, valid], [valid], [{ ...valid, candidateId: 'foreign' }]]) {
    assert.throws(() => renderExplanationResponse(source, candidates, resolveEvidence(input, { explanations: entries })),
      e => e instanceof ProviderError && e.kind === 'invalid');
  }
});

test('selection experiment does not repair malformed prose, fabricate evidence or bypass length limits', () => {
  const source = '원문'; const candidates = [{ id: 'one', text: '후보' }];
  const input = buildEvidenceInput(source, candidates);
  for (const draft of [
    { candidateId: 'one', evidenceIds: ['c1-e1'], explanation: '‘후보로 바꿨습니다.' },
    { candidateId: 'one', evidenceIds: ['c1-e1'], explanation: '가'.repeat(400) },
    { candidateId: 'one', evidenceIds: ['c1-e1'], explanation: '변경', references: [] },
  ]) assert.deepEqual(renderExplanationResponse(source, candidates, resolveEvidence(input, { explanations: [draft] })),
    [{ candidateId: 'one', error: 'EXPLANATION_INVALID' }]);
});

test('unchanged text uses empty evidence and mechanically correct evidence does not prove meaning', () => {
  const source = '원문'; const candidates = [{ id: 'one', text: source }];
  const input = buildEvidenceInput(source, candidates);
  assert.deepEqual(input.candidates[0].evidence, []);
  assert.deepEqual(renderExplanationResponse(source, candidates, resolveEvidence(input, {
    explanations: [{ candidateId: 'one', evidenceIds: [], explanation: '잘못된 모델 주장' }],
  })), [{ candidateId: 'one', explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' }]);
  const changed = [{ id: 'one', text: '후보' }];
  assert.ok('explanation' in renderExplanationResponse(source, changed, resolveEvidence(buildEvidenceInput(source, changed), {
    explanations: [{ candidateId: 'one', evidenceIds: ['c1-e1'], explanation: '원문에 없는 사실을 보증합니다.' }],
  }))[0]);
});
