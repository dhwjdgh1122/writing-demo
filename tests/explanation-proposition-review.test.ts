import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error Offline JavaScript helpers; no network or model calls on import.
import { REVIEW_CONTRACT_VERSION, createPropositionReviewSnapshot, applyPropositionReview } from '../scripts/lib/explanation-proposition-review.mjs';
// @ts-expect-error Existing diagnostic remains unchanged and keeps its original failure contract.
import { validatePropositionResult } from '../scripts/lib/explanation-propositions.mjs';

type Proposition = { id: string; statement: string; originId: string };
type TextInput = { texts: { id: string; text: string }[] };
type ReviewCase = { id: string; propositions: Proposition[]; supports: any[]; relations: any[]; coverage: any[] };
const fixtureUrl = new URL('./fixtures/explanation-proposition-review-2026-11-22.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { scope: string; sourceFixture: string; cases: ReviewCase[] };
const sourceFixture = JSON.parse(readFileSync(new URL(`./fixtures/${fixture.sourceFixture}`, import.meta.url), 'utf8'));
const context = { runId: 'offline-review-run', requestId: 'offline-request-1' };
const emptyHistory = () => ({ activeRevisions: [], revisions: [] });
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const getCase = (id = 'CT-03') => fixture.cases.find(item => item.id === id)!;
function caseInput(id = 'CT-03'): TextInput {
  const row = sourceFixture.cases.find((item: { id: string }) => item.id === id);
  return { texts: [{ id: 't1', text: row.sourceText }, { id: 't2', text: row.candidates[0].text }] };
}
function makeSnapshot(id = 'CT-03', propositions = getCase(id).propositions, input = caseInput(id)) {
  const result = createPropositionReviewSnapshot(input, JSON.stringify({ propositions }), context);
  assert.equal(result.ok, true);
  return result.snapshot;
}
function makeRevision(snapshot: any, id = 'CT-03', revision = 1) {
  const row = getCase(id);
  return { reviewRevision: revision, binding: clone(snapshot.binding), reviewer: { kind: 'ai-assisted', id: 'synthetic-test-reviewer' },
    withdrawn: false, supports: clone(row.supports), relations: clone(row.relations), coverage: clone(row.coverage) };
}
const historyFor = (revision: any) => ({ activeRevisions: [revision.reviewRevision], revisions: [revision] });
const group = (revision = 1, memberIds = ['h1', 'h2']) => ({ reviewRevision: revision, representativeId: memberIds[0], memberIds });
function assertNoSemanticPass(value: any) {
  assert.equal(value.semanticAssessment, 'not-performed');
  for (const key of ['qualityPassed', 'faithful', 'complete', 'equivalent', 'entailed', 'satisfied']) {
    assert.equal(Object.hasOwn(value, key), false, `must not claim ${key}`);
  }
}

test('snapshots bind exact ordered input/output arrays and raw bytes without normalization', () => {
  assert.equal(REVIEW_CONTRACT_VERSION, 'proposition-review-v1');
  assert.match(fixture.scope, /합성/);
  const input: TextInput = { texts: [{ id: 't2', text: '🙂 가\r\n\r\n나 é e\u0301 가 반복 반복' }, { id: 't1', text: '별도 문장' }] };
  const propositions = [{ originId: 't2', statement: '🙂 문장을 검토한다.', id: 'h1' }];
  const raw = JSON.stringify({ propositions }, null, 2);
  const before = clone(input);
  const result = createPropositionReviewSnapshot(input, new TextEncoder().encode(raw), context);
  assert.equal(result.ok, true);
  const snapshot = result.snapshot;
  assert.equal(snapshot.binding.inputSha256, digest(JSON.stringify(input.texts.map(({ id, text }) => ({ id, text })))));
  assert.equal(snapshot.binding.outputSha256, digest(JSON.stringify(propositions.map(({ id, statement, originId }) => ({ id, statement, originId })))));
  assert.equal(snapshot.rawResponseSha256, digest(raw));
  assert.equal(snapshot.propositions[0].sourceContext, input.texts[0].text);
  assert.deepEqual(input, before);
  input.texts[0].text = 'caller mutation';
  assert.deepEqual(snapshot.input, before);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.binding), true);
  assert.equal(Object.isFrozen(snapshot.input.texts[0]), true);
  assert.equal(Object.isFrozen(snapshot.propositions[0]), true);
  assert.throws(() => { snapshot.propositions[0].sourceContext = 'changed'; }, TypeError);
  assertNoSemanticPass(snapshot);
  const otherLayout = createPropositionReviewSnapshot(before, JSON.stringify({ propositions }), context).snapshot;
  assert.equal(otherLayout.binding.outputSha256, snapshot.binding.outputSha256);
  assert.notEqual(otherLayout.rawResponseSha256, snapshot.rawResponseSha256);
});

test('invalid responses retain a raw hash but never gain a successful output hash', () => {
  const base = clone(getCase().propositions[0]);
  const invalid: any[] = [null, {}, { propositions: [] }, { propositions: [{ ...base, quote: 'invented' }] },
    { propositions: [{ ...base, id: 'h9' }] }, { propositions: [{ ...base, originId: 'other' }] },
    { propositions: [{ ...base, statement: ' ' }] }, { propositions: [{ ...base, statement: '🙂'.repeat(301) }] },
    { propositions: [{ ...base, statement: 1 }] }, { propositions: [base], explanation: 'extra' },
    { propositions: [base, { ...base, statement: 'different' }] },
    { propositions: Array.from({ length: 9 }, (_, i) => ({ ...base, id: `h${i + 1}`, statement: `명제 ${i}` })) }];
  for (const raw of ['{', ...invalid.map(value => JSON.stringify(value))]) {
    const checked = createPropositionReviewSnapshot(caseInput(), raw, context);
    assert.equal(checked.ok, false);
    assert.equal(checked.rawResponseSha256, digest(raw));
    assert.equal(Object.hasOwn(checked, 'outputSha256'), false);
    assert.equal(Object.hasOwn(checked, 'snapshot'), false);
    assertNoSemanticPass(checked);
  }
  const eight = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `h${i + 1}`, statement: i ? `명제 ${i}` : '🙂'.repeat(300) }));
  assert.equal(createPropositionReviewSnapshot(caseInput(), JSON.stringify({ propositions: eight }), context).ok, true);
});

test('input answer metadata and invalid opaque texts are refused before response inspection', () => {
  const input = caseInput(), raw = JSON.stringify({ propositions: getCase().propositions });
  for (const bad of [{ ...input, expected: true }, { ...input, required: ['answer'] },
    { texts: [{ ...input.texts[0], role: 'source' }, input.texts[1]] },
    { texts: [input.texts[0], input.texts[0]] }, { texts: [{ id: 't1', text: ' ' }, input.texts[1]] },
    { texts: [{ id: 't1', text: '가'.repeat(2001) }, input.texts[1]] }]) {
    assert.throws(() => createPropositionReviewSnapshot(bad, raw, context));
  }
});

test('only exact same-origin statement duplicates fail; cross-origin and differently worded claims survive', () => {
  const base = clone(getCase().propositions[0]);
  const raw = (items: Proposition[]) => JSON.stringify({ propositions: items });
  assert.equal(createPropositionReviewSnapshot(caseInput(), raw([base, { ...base, id: 'h2' }]), context).ok, false);
  const cross = createPropositionReviewSnapshot(caseInput(), raw([base, { ...base, id: 'h2', originId: 't2' }]), context);
  assert.equal(cross.ok, true);
  assert.equal(cross.snapshot.propositions.length, 2);
  assert.notEqual(cross.snapshot.propositions[0].sourceContext, cross.snapshot.propositions[1].sourceContext);
  assert.equal(createPropositionReviewSnapshot(caseInput(), raw([base, { ...base, id: 'h2', statement: `${base.statement} ` }]), context).ok, true);
  const unreviewed = applyPropositionReview(cross.snapshot, emptyHistory());
  assert.equal(unreviewed.ok, true);
  assert.deepEqual(unreviewed.groups, []);
  assert.equal(unreviewed.reviewRevision, null);
  assertNoSemanticPass(unreviewed);
});

test('a false claim with a valid origin is only structurally connected, never quality approved', () => {
  const snapshot = makeSnapshot('CT-03', [{ id: 'h1', originId: 't1', statement: '비회원도 이미 자료를 모두 받았다.' }]);
  const checked = applyPropositionReview(snapshot, emptyHistory());
  assert.equal(checked.ok, true);
  assert.equal(checked.propositions[0].statement, '비회원도 이미 자료를 모두 받았다.');
  assert.deepEqual(checked.groups, []);
  assertNoSemanticPass(checked);
  assert.equal(applyPropositionReview(snapshot, emptyHistory(), [group()]).ok, false);
});

test('CT-03 preserves both origins in a manually reviewed group in either input order', () => {
  for (const reverse of [false, true]) {
    const input = caseInput();
    if (reverse) input.texts.reverse();
    const snapshot = makeSnapshot('CT-03', getCase().propositions, input);
    const revision = makeRevision(snapshot);
    const before = clone(revision);
    const result = applyPropositionReview(snapshot, historyFor(revision), [group()]);
    assert.equal(result.ok, true);
    assert.equal(result.reviewRevision, 1);
    assert.deepEqual(result.groups[0].memberIds, ['h1', 'h2']);
    assert.equal(result.groups[0].representativeId, 'h1');
    assert.deepEqual(result.groups[0].members, snapshot.propositions);
    assert.deepEqual(result.groups[0].binding, snapshot.binding);
    assert.deepEqual(result.supports, revision.supports);
    assert.deepEqual(result.relations, revision.relations);
    assert.deepEqual(result.coverage, revision.coverage);
    assert.deepEqual(revision, before);
    assertNoSemanticPass(result);
  }
});

test('EQ-03 and small negation/count/modality contrasts are never automatically merged', () => {
  for (const reverse of [false, true]) {
    const input = caseInput('EQ-03');
    if (reverse) input.texts.reverse();
    const snapshot = makeSnapshot('EQ-03', getCase('EQ-03').propositions, input);
    const history = historyFor(makeRevision(snapshot, 'EQ-03'));
    const result = applyPropositionReview(snapshot, history);
    assert.equal(result.ok, true);
    assert.deepEqual(result.groups, []);
    assert.equal(result.relations[0].status, 'different');
    assert.equal(applyPropositionReview(snapshot, history, [group()]).ok, false);
  }
  for (const [left, right] of [['발송하지 않는다.', '발송한다.'], ['8명에게 발송한다.', '10명에게 발송한다.'], ['발송할 수 있다.', '발송했다.']]) {
    const input = { texts: [{ id: 't1', text: left }, { id: 't2', text: right }] };
    const snapshot = makeSnapshot('CT-03', [{ id: 'h1', originId: 't1', statement: left }, { id: 'h2', originId: 't2', statement: right }], input);
    assert.deepEqual(applyPropositionReview(snapshot, emptyHistory()).groups, []);
  }
});

test('E-03 keeps the eight source-information checks; full context does not replace a missing claim', () => {
  const snapshot = makeSnapshot('E-03');
  const revision = makeRevision(snapshot, 'E-03');
  const reviewed = applyPropositionReview(snapshot, historyFor(revision));
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.coverage.length, 8);
  assert.deepEqual(reviewed.coverage, getCase('E-03').coverage);
  assert.equal(snapshot.propositions[0].sourceContext, caseInput('E-03').texts[0].text);
  assert.match(snapshot.propositions[0].sourceContext, /발송은 확정되지 않았습니다/);
  assert.equal(applyPropositionReview(snapshot, historyFor(revision), [group(1, ['h1', 'h2', 'h3'])]).ok, false);
  const withoutUnconfirmed = makeSnapshot('E-03', getCase('E-03').propositions.filter(item => item.id !== 'h2'));
  const incomplete = makeRevision(withoutUnconfirmed, 'E-03');
  incomplete.supports = incomplete.supports.filter(item => item.propositionId !== 'h2');
  incomplete.relations = incomplete.relations.filter(item => item.leftId !== 'h2' && item.rightId !== 'h2');
  const unconfirmed = incomplete.coverage.find(item => item.id === 'e-source-unconfirmed');
  unconfirmed.status = 'missing'; unconfirmed.propositionIds = []; unconfirmed.reason = '합성 결함: 문맥에는 있지만 생성 명제가 누락했다.';
  const result = applyPropositionReview(withoutUnconfirmed, historyFor(incomplete));
  assert.equal(result.ok, true);
  assert.equal(result.coverage.find((item: any) => item.id === 'e-source-unconfirmed').status, 'missing');
  assertNoSemanticPass(result);
});

test('all five binding components reject review reuse, including an inactive historical revision', () => {
  const snapshot = makeSnapshot();
  for (const key of ['runId', 'requestId', 'contractVersion', 'inputSha256', 'outputSha256']) {
    const revision = makeRevision(snapshot);
    revision.binding[key] = key.endsWith('Sha256') ? '0'.repeat(64) : `foreign-${key}`;
    assert.equal(applyPropositionReview(snapshot, historyFor(revision)).ok, false, key);
    const latest = makeRevision(snapshot, 'CT-03', 2);
    assert.equal(applyPropositionReview(snapshot, { activeRevisions: [2], revisions: [revision, latest] }).ok, false, `inactive ${key}`);
  }
});

test('snapshot tampering cannot alter the text, claim, source context or integrity binding', () => {
  const snapshot = makeSnapshot();
  const mutations = [
    (value: any) => { value.input.texts[0].text = 'forged source'; },
    (value: any) => { value.propositions[0].statement = 'forged claim'; },
    (value: any) => { value.propositions[0].originId = 't2'; },
    (value: any) => { value.propositions[0].sourceContext = 'forged context'; },
    (value: any) => { value.binding.inputSha256 = '0'.repeat(64); },
    (value: any) => { value.binding.outputSha256 = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const altered = clone(snapshot); mutate(altered);
    assert.equal(applyPropositionReview(altered, emptyHistory()).ok, false);
  }
});

test('review schema refuses foreign references, self-pairs, blank evidence and undeclared fields', () => {
  const snapshot = makeSnapshot();
  const mutations = [
    (value: any) => { value.supports[0].propositionId = 'h8'; },
    (value: any) => { value.supports[0].reason = ' '; },
    (value: any) => { value.supports[0].status = 'approved'; },
    (value: any) => { value.relations[0].leftId = 'h8'; },
    (value: any) => { value.relations[0].rightId = 'h1'; },
    (value: any) => { value.relations[0].reason = ''; },
    (value: any) => { value.relations[0].status = 'contradicted'; },
    (value: any) => { value.coverage[0].propositionIds = ['h8']; },
    (value: any) => { value.coverage[0].originId = 'outside'; },
    (value: any) => { value.coverage[0].originId = 't2'; },
    (value: any) => { value.coverage[0].propositionIds = ['h1', 'h1']; },
    (value: any) => { value.coverage.push(clone(value.coverage[0])); },
    (value: any) => { value.coverage[0].information = ' '; },
    (value: any) => { value.coverage[0].id = ''; },
    (value: any) => { value.coverage[0].reason = ''; },
    (value: any) => { value.coverage[0].propositionIds = []; },
    (value: any) => { value.reviewer.kind = 'automatic-truth'; },
    (value: any) => { value.reviewer.id = ''; },
    (value: any) => { value.reviewRevision = 0; },
    (value: any) => { value.qualityPassed = true; },
  ];
  for (const mutate of mutations) {
    const revision = makeRevision(snapshot); mutate(revision);
    assert.equal(applyPropositionReview(snapshot, historyFor(revision)).ok, false);
  }
  const incomplete = makeRevision(snapshot);
  incomplete.coverage[0].status = 'missing'; incomplete.coverage[0].propositionIds = [];
  assert.equal(applyPropositionReview(snapshot, historyFor(incomplete)).ok, true);
});

test('duplicate support, relation in either direction and revision IDs fail even when decisions agree', () => {
  const snapshot = makeSnapshot();
  for (const change of [
    (value: any) => value.supports.push(clone(value.supports[0])),
    (value: any) => value.supports.push({ ...value.supports[0], status: 'uncertain' }),
    (value: any) => value.relations.push(clone(value.relations[0])),
    (value: any) => value.relations.push({ ...value.relations[0], leftId: 'h2', rightId: 'h1' }),
    (value: any) => value.relations.push({ ...value.relations[0], leftId: 'h2', rightId: 'h1', status: 'different' }),
  ]) {
    const revision = makeRevision(snapshot); change(revision);
    assert.equal(applyPropositionReview(snapshot, historyFor(revision), [group()]).ok, false);
  }
  const revision = makeRevision(snapshot);
  assert.equal(applyPropositionReview(snapshot, { activeRevisions: [1], revisions: [revision, clone(revision)] }).ok, false);
});

test('no active review yields no group; multiple, stale or withdrawn active revisions cannot restore old positives', () => {
  const snapshot = makeSnapshot(), first = makeRevision(snapshot), latest = makeRevision(snapshot, 'CT-03', 2);
  latest.relations[0].status = 'uncertain';
  const revisions = [first, latest];
  const inactive = applyPropositionReview(snapshot, { activeRevisions: [], revisions });
  assert.equal(inactive.ok, true); assert.equal(inactive.reviewRevision, null); assert.equal(inactive.reviewer, null);
  assert.deepEqual(inactive.groups, []);
  for (const activeRevisions of [[1, 2], [2, 2], [1], [3]]) {
    assert.equal(applyPropositionReview(snapshot, { activeRevisions, revisions }, [group()]).ok, false);
  }
  assert.equal(applyPropositionReview(snapshot, { activeRevisions: [], revisions }, [group()]).ok, false);
  assert.equal(applyPropositionReview(snapshot, { activeRevisions: [2], revisions }).ok, true);
  assert.equal(applyPropositionReview(snapshot, { activeRevisions: [2], revisions }, [group(2)]).ok, false);
  const withdrawn = clone(latest); withdrawn.withdrawn = true;
  assert.equal(applyPropositionReview(snapshot, { activeRevisions: [2], revisions: [first, withdrawn] }).ok, false);
  assert.equal(applyPropositionReview(snapshot, { activeRevisions: [1], revisions: [first, withdrawn] }, [group()]).ok, false);
});

test('every group member requires supported provenance and every pair requires an explicit same review', () => {
  const snapshot = makeSnapshot();
  for (const status of ['unreviewed', 'unsupported', 'uncertain']) {
    const revision = makeRevision(snapshot); revision.supports[0].status = status;
    assert.equal(applyPropositionReview(snapshot, historyFor(revision)).ok, true);
    assert.equal(applyPropositionReview(snapshot, historyFor(revision), [group()]).ok, false);
  }
  for (const status of ['unreviewed', 'different', 'uncertain']) {
    const revision = makeRevision(snapshot); revision.relations[0].status = status;
    assert.equal(applyPropositionReview(snapshot, historyFor(revision)).ok, true);
    assert.equal(applyPropositionReview(snapshot, historyFor(revision), [group()]).ok, false);
  }
  for (const field of ['supports', 'relations']) {
    const revision: any = makeRevision(snapshot); revision[field] = [];
    assert.equal(applyPropositionReview(snapshot, historyFor(revision), [group()]).ok, false);
  }
});

test('a three-member group requires all three pairs rather than transitive completion', () => {
  const propositions = [...clone(getCase().propositions), { id: 'h3', originId: 't1', statement: '회원인 사람만 자료를 받을 수 있다.' }];
  const snapshot = makeSnapshot('CT-03', propositions), revision = makeRevision(snapshot);
  revision.supports.push({ propositionId: 'h3', status: 'supported', reason: '수동 작성한 합성 검토.' });
  revision.relations.push({ leftId: 'h2', rightId: 'h3', status: 'same', reason: '수동 작성한 합성 관계.' });
  const proposed = [group(1, ['h1', 'h2', 'h3'])];
  assert.equal(applyPropositionReview(snapshot, historyFor(revision), proposed).ok, false);
  revision.relations.push({ leftId: 'h1', rightId: 'h3', status: 'same', reason: '누락된 세 번째 관계를 수동 입력.' });
  const result = applyPropositionReview(snapshot, historyFor(revision), proposed);
  assert.equal(result.ok, true);
  assert.equal(result.groups[0].members.length, 3);
  assert.deepEqual(result.propositions, snapshot.propositions);
  assertNoSemanticPass(result);
});

test('group IDs, representative, overlap and review revision are all checked', () => {
  const snapshot = makeSnapshot(), history = historyFor(makeRevision(snapshot));
  const invalid = [
    [group(2)], [group(1, ['h1'])], [group(1, ['h1', 'h1'])], [group(1, ['h1', 'h8'])],
    [{ ...group(), representativeId: 'h8' }], [group(), group()],
    [group(), { ...group(), memberIds: ['h2', 'h1'], representativeId: 'h2' }],
    [{ ...group(), verdict: 'correct' }],
  ];
  for (const proposed of invalid) assert.equal(applyPropositionReview(snapshot, history, proposed).ok, false);
  const changed = makeRevision(snapshot, 'CT-03', 2);
  const latest = { activeRevisions: [2], revisions: [history.revisions[0], changed] };
  assert.equal(applyPropositionReview(snapshot, latest, [group()]).ok, false);
  assert.equal(applyPropositionReview(snapshot, latest, [group(2)]).ok, true);
});

test('review output detaches caller state and retains reviewer identity without certifying meaning', () => {
  const snapshot = makeSnapshot(), revision = makeRevision(snapshot);
  revision.reviewer.kind = 'human'; revision.reviewer.id = 'synthetic-human-role';
  const history = historyFor(revision), proposed = [group()];
  const before = clone({ history, proposed, snapshot });
  const result = applyPropositionReview(snapshot, history, proposed);
  assert.equal(result.ok, true);
  assert.deepEqual(result.reviewer, revision.reviewer);
  history.revisions[0].supports[0].reason = 'caller mutation';
  proposed[0].memberIds.reverse();
  assert.deepEqual(result.supports, before.history.revisions[0].supports);
  assert.deepEqual(result.groups[0].memberIds, before.proposed[0].memberIds);
  assert.deepEqual(snapshot, before.snapshot);
  assertNoSemanticPass(result);
});

test('swapping text ownership preserves opaque origins instead of treating t1 as the original by definition', () => {
  for (const id of ['CT-03', 'EQ-03', 'E-03']) {
    const swap = (originId: string) => originId === 't1' ? 't2' : 't1';
    const input = caseInput(id);
    input.texts = input.texts.map(item => ({ ...item, id: swap(item.id) }));
    const propositions = getCase(id).propositions.map(item => ({ ...item, originId: swap(item.originId) }));
    const snapshot = makeSnapshot(id, propositions, input), revision = makeRevision(snapshot, id);
    revision.coverage = revision.coverage.map(item => ({ ...item, originId: swap(item.originId) }));
    const result = applyPropositionReview(snapshot, historyFor(revision), id === 'CT-03' ? [group()] : []);
    assert.equal(result.ok, true);
    for (const proposition of result.propositions) {
      assert.equal(proposition.sourceContext, input.texts.find(item => item.id === proposition.originId)!.text);
    }
    assert.deepEqual(result.coverage, revision.coverage);
    assert.equal(result.groups.length, id === 'CT-03' ? 1 : 0);
    assertNoSemanticPass(result);
  }
});

test('an old failed response is immutable evidence, not a newly successful model run', () => {
  const rawUrl = new URL('../docs/evaluations/explanation-propositions-2026-11-22-elice.json', import.meta.url);
  const ledgerUrl = new URL('../docs/evaluations/approved-model-calls-continuation-2026-11-22.json', import.meta.url);
  const rawBefore = readFileSync(rawUrl), ledgerBefore = readFileSync(ledgerUrl);
  const archived = JSON.parse(rawBefore.toString('utf8'));
  const failed = archived.runs.find((run: { caseId: string }) => run.caseId === 'E-03');
  assert.equal(failed.propositionValidation.ok, false);
  assert.equal(validatePropositionResult(failed.sentInput, failed.parsedModelOutput).ok, false);
  const untouchedOldResponse = createPropositionReviewSnapshot(failed.sentInput, failed.rawCompletion.text, context);
  assert.equal(untouchedOldResponse.ok, false, 'the old quote field is not silently discarded');
  assert.equal(untouchedOldResponse.rawResponseSha256, digest(failed.rawCompletion.text));
  const derivedAdapterExample = failed.parsedModelOutput.propositions.map(({ id, statement, originId }: Proposition) => ({ id, statement, originId }));
  // This is only a hand-derived adapter input: never write it back or score it as a model success.
  const converted = createPropositionReviewSnapshot(failed.sentInput, JSON.stringify({ propositions: derivedAdapterExample }),
    { runId: 'synthetic-adapter-only', requestId: 'not-a-new-model-call' });
  assert.equal(converted.ok, true);
  const result = applyPropositionReview(converted.snapshot, emptyHistory());
  assert.equal(result.ok, true);
  assert.equal(result.reviewRevision, null);
  assert.deepEqual(result.groups, []);
  assertNoSemanticPass(result);
  assert.equal(validatePropositionResult(failed.sentInput, failed.parsedModelOutput).ok, false);
  assert.equal(digest(readFileSync(rawUrl)), digest(rawBefore));
  assert.equal(digest(readFileSync(ledgerUrl)), digest(ledgerBefore));
});
