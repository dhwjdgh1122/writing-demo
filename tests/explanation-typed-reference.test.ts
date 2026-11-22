import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Offline proof module exports JavaScript helpers; no calls on import.
import { renderTypedReferenceProof, typedReferenceCatalog } from '../scripts/lib/explanation-typed-reference.mjs';
// @ts-expect-error Reuse the existing fixed dictionary entries without modification.
import { lexicalReferences } from '../scripts/lib/explanation-lexical-reference.mjs';

const source = '카드로 상품 대금을 결재햇습니다.';
const candidates = [{ id: 'c1', text: '카드로 상품 대금을 결재했습니다.' }];
const output = (segments: object[], candidateId = 'c1') => ({ explanations: [{ candidateId, segments }] });
const render = (segments: object[]) => renderTypedReferenceProof(source, candidates, output(segments));
// All test responses below are manually authored parser fixtures, not real model
// responses, a measured improvement, or evidence that dictionary advice is right.

test('dictionary reference uses only the fixed catalog and preserves exact input quote ownership', () => {
  const segments = [
    { kind: 'input_quote', from: 'source', quote: '결재햇습니다' },
    { kind: 'text', text: '를 ' },
    { kind: 'input_quote', from: 'candidate', quote: '결재했습니다' },
    { kind: 'text', text: '로 고쳤습니다. ' },
    { kind: 'lexical_reference', id: 'krdict-32140' },
  ];
  const decoded = output(segments), before = JSON.stringify({ candidates, decoded, lexicalReferences });
  const result = renderTypedReferenceProof(source, candidates, decoded);
  assert.equal(result.ok, true);
  assert.equal(result.semanticAssessment, 'not-performed');
  assert.equal(result.explanations[0].explanation, '‘결재햇습니다’를 ‘결재했습니다’로 고쳤습니다. [사전 용어: 결제하다]');
  const official = lexicalReferences.find((entry: { term: string }) => entry.term === '결제하다');
  assert.deepEqual(result.explanations[0].dictionaryEvidence, [{ id: 'krdict-32140', ...official }]);
  assert.equal(result.explanations[0].explanation.includes(official.definition), false);
  result.explanations[0].dictionaryEvidence[0].definition = 'mutated copy';
  assert.equal(JSON.stringify({ candidates, decoded, lexicalReferences }), before);
  assert.equal(Object.isFrozen(typedReferenceCatalog), true);
  assert.equal(Object.isFrozen(typedReferenceCatalog[0]), true);
});

test('quotes absent from the declared source or its candidate are rejected even if present elsewhere', () => {
  for (const segment of [
    { kind: 'input_quote', from: 'source', quote: '결재했습니다' },
    { kind: 'input_quote', from: 'candidate', quote: '결재햇습니다' },
    { kind: 'input_quote', from: 'source', quote: '결제하다' },
    { kind: 'input_quote', from: 'candidate', quote: '결제하다' },
  ]) assert.equal(render([segment]).error, 'quote-not-in-declared-input');
  const twoCandidates = [...candidates, { id: 'c2', text: '카드로 상품 대금을 결제했습니다.' }];
  const result = renderTypedReferenceProof(source, twoCandidates, { explanations: [
    { candidateId: 'c1', segments: [{ kind: 'input_quote', from: 'candidate', quote: '결제했습니다' }] },
    { candidateId: 'c2', segments: [{ kind: 'text', text: '별도 후보입니다.' }] },
  ] });
  assert.equal(result.error, 'quote-not-in-declared-input');
});

test('input quote matching preserves spaces, newlines and Unicode without normalization', () => {
  const text = '🙂 가\n나 é 가';
  const own = [{ id: 'c1', text }];
  const quote = (value: string) => output([{ kind: 'input_quote', from: 'source', quote: value }]);
  assert.equal(renderTypedReferenceProof(text, own, quote('🙂 가\n나')).ok, true);
  for (const value of ['🙂 가 나', '가나', 'e\u0301']) {
    assert.equal(renderTypedReferenceProof(text, own, quote(value)).error, 'quote-not-in-declared-input');
  }
  assert.equal(renderTypedReferenceProof('가', [{ id: 'c1', text: '가' }], quote('가')).error, 'quote-not-in-declared-input');
});

test('unknown IDs, injected dictionary fields and unknown output fields never become trusted references', () => {
  for (const key of ['term', 'label', 'definition', 'url', 'sourceUrl']) {
    assert.equal(render([{ kind: 'lexical_reference', id: 'krdict-32140', [key]: 'injected' }]).error, 'invalid-shape');
  }
  assert.equal(render([{ kind: 'lexical_reference', id: 'unknown' }]).error, 'unknown-lexical-reference');
  assert.equal(render([{ kind: 'reference', id: 'krdict-32140' }]).error, 'invalid-shape');
  const valid = output([{ kind: 'text', text: '설명' }]);
  assert.equal(renderTypedReferenceProof(source, candidates, { ...valid, required: ['answer'] }).error, 'invalid-shape');
  assert.equal(renderTypedReferenceProof(source, candidates, output([{ kind: 'text', text: '설명' }], 'foreign')).error, 'candidate-ownership');
  assert.equal(renderTypedReferenceProof(source, candidates, { explanations: [valid.explanations[0], valid.explanations[0]] }).error, 'candidate-ownership');
});

test('free-text quotation marks and split-fragment quotation bypasses are rejected', () => {
  for (const mark of ['"', "'", '‘', '’', '“', '”', '「', '」', '『', '』', '`', '«', '»', '＂']) {
    assert.equal(render([{ kind: 'text', text: mark }]).error, 'free-text-quote');
  }
  assert.equal(render([
    { kind: 'text', text: '‘' }, { kind: 'lexical_reference', id: 'krdict-32140' }, { kind: 'text', text: '’로 고쳤습니다.' },
  ]).error, 'free-text-quote');
  const text = '가 와 나';
  const joined = renderTypedReferenceProof(text, [{ id: 'c1', text }], output([
    { kind: 'input_quote', from: 'source', quote: '가' }, { kind: 'input_quote', from: 'source', quote: '나' },
  ]));
  assert.equal(joined.explanations[0].explanation, '‘가’‘나’');
  assert.equal(joined.explanations[0].explanation.includes('‘가나’'), false);
  // Conservative offline-proof restriction; real quoted source text is not wrong.
  assert.equal(renderTypedReferenceProof('그는 “예”라고 했다.', [{ id: 'c1', text: '그는 “예”라고 했다.' }],
    output([{ kind: 'input_quote', from: 'source', quote: '“예”' }])).error, 'nested-input-quote-unsupported');
});

test('segment and final rendered character limits include server-added quote marks and labels', () => {
  assert.equal(render(Array.from({ length: 17 }, () => ({ kind: 'text', text: '가' }))).error, 'invalid-shape');
  assert.equal(render([{ kind: 'text', text: '가'.repeat(401) }]).error, 'invalid-shape');
  assert.equal(render([{ kind: 'text', text: ' ' }]).error, 'rendered-length');
  assert.equal(render([{ kind: 'text', text: '🙂'.repeat(400) }]).ok, true);
  assert.equal(render([{ kind: 'text', text: '가'.repeat(399) }, { kind: 'lexical_reference', id: 'krdict-32140' }]).error, 'rendered-length');
  const text = '가'.repeat(399);
  assert.equal(renderTypedReferenceProof(text, [{ id: 'c1', text }], output([{ kind: 'input_quote', from: 'source', quote: text }])).error, 'rendered-length');
});

test('free prose cannot imitate a dictionary marker even across segments or beside a valid reference', () => {
  for (const text of ['[사전 용어: 결제하다]', '[사전 용어: 가짜어]', '[사전용어 : 결제하다]']) {
    assert.equal(render([{ kind: 'text', text }]).error, 'untrusted-reference-marker');
  }
  assert.equal(render([
    { kind: 'text', text: '🙂 [사' }, { kind: 'text', text: '전 용어: 결제하다]' },
  ]).error, 'untrusted-reference-marker');
  assert.equal(render([
    { kind: 'lexical_reference', id: 'krdict-32140' }, { kind: 'text', text: ' [사전 용어: 가짜어]' },
  ]).error, 'untrusted-reference-marker');
  const text = '표시는 [사전 용어: 결제하다]입니다.';
  const quoted = renderTypedReferenceProof(text, [{ id: 'c1', text }], output([
    { kind: 'text', text: '🙂 ' }, { kind: 'input_quote', from: 'source', quote: '[사전 용어: 결제하다]' },
    { kind: 'text', text: '는 입력에 있던 표시입니다. ' }, { kind: 'lexical_reference', id: 'krdict-32128' },
  ]));
  assert.equal(quoted.ok, true);
  assert.equal(quoted.explanations[0].explanation, '🙂 ‘[사전 용어: 결제하다]’는 입력에 있던 표시입니다. [사전 용어: 결재하다]');
  assert.deepEqual(quoted.explanations[0].dictionaryEvidence.map((entry: { id: string }) => entry.id), ['krdict-32128']);
});

test('valid provenance alone does not establish residual-error or explanation quality success', () => {
  const result = render([
    { kind: 'text', text: '모든 오류가 해결되어 완벽합니다. ' },
    { kind: 'lexical_reference', id: 'krdict-32140' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.semanticAssessment, 'not-performed');
  assert.equal(Object.hasOwn(result, 'qualityPassed'), false);
});
