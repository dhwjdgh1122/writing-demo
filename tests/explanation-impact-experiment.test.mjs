import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveImpact, impactResponseSchema } from '../scripts/lib/explanation-impact-experiment.mjs';
import { renderExplanationResponse } from '../server/llm/explanation-response.ts';
import { ProviderError } from '../server/llm/provider.ts';

const source = '목요일에 15명에게 안내합니다.';
const candidates = [{ id: 'a', text: '이후에 안내합니다.' }, { id: 'b', text: '목요일에 15명에게 알려드립니다.' }];
const changed = { candidateId: 'a', references: [{ before: '목요일에 15명에게', after: '이후에' }],
  summary: '일정과 인원 표현이 바뀌었습니다.', impact: '안내할 날짜와 인원이 구체적으로 드러나지 않습니다.',
  choice: '목요일에 15명에게 안내하려는 뜻이라면 해당 정보를 유지하는 표현이 맞습니다.' };
const simple = { candidateId: 'b', references: [{ before: '안내합니다.', after: '알려드립니다.' }],
  summary: '안내한다는 뜻을 유지하며 표현을 바꿨습니다.', impact: '', choice: '' };
const render = entries => renderExplanationResponse(source, candidates, resolveImpact({ explanations: entries }));

test('visible prose fields join without generating advice; simple changes do not acquire a warning', () => {
  const mapped = resolveImpact({ explanations: [changed, simple] });
  assert.equal(mapped.explanations[0].explanation, [changed.summary, changed.impact, changed.choice].join(' '));
  assert.equal(mapped.explanations[1].explanation, simple.summary);
  assert.deepEqual(mapped.explanations[0].references, changed.references);
  assert.ok(render([changed, simple]).every(r => 'explanation' in r));
  assert.deepEqual(impactResponseSchema(['a']).properties.explanations.items.required,
    ['candidateId', 'references', 'summary', 'impact', 'choice']);
});

test('missing guidance, malformed prose and oversized output fail only the affected candidate', () => {
  for (const invalid of [
    { ...changed, choice: '' }, { ...changed, impact: '' }, { ...changed, summary: ' ' },
    { ...changed, impact: ' ' }, { ...changed, choice: undefined }, { ...changed, summary: '첫 줄\n다음 줄' },
    { ...changed, choice: '“닫히지 않은 인용' }, { ...changed, summary: '가'.repeat(400) },
    { ...changed, extra: 'discarding this must not rescue a malformed draft' },
  ]) {
    const results = render([invalid, simple]);
    assert.deepEqual(results[0], { candidateId: 'a', error: 'EXPLANATION_INVALID' });
    assert.ok('explanation' in results[1]);
  }
});

test('bridge preserves exact quote checks and rejects missing, duplicate or foreign ownership', () => {
  for (const invalid of [
    { ...changed, impact: '‘금요일’ 일정이 없어졌습니다.' },
    { ...changed, references: [{ before: '목요일에15명에게', after: '이후에' }] },
  ]) assert.deepEqual(render([invalid, simple])[0], { candidateId: 'a', error: 'EXPLANATION_QUOTE_MISMATCH' });
  for (const entries of [[changed], [changed, changed], [changed, { ...simple, candidateId: 'foreign' }]])
    assert.throws(() => render(entries), e => e instanceof ProviderError && e.kind === 'invalid');
});

test('well-formed prose is not semantic verification, including incorrectly empty impact and choice', () => {
  // Must remain an evaluation failure, even though structural validation cannot detect it.
  const misleading = { ...changed, impact: '', choice: '', summary: '일정과 인원은 그대로입니다.' };
  assert.ok('explanation' in render([misleading, simple])[0]);
});
