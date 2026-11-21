import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error Manual runner exports pure helpers; CLI execution is guarded.
import { buildCrossReviewPlan, crossReviewModelInput, parseFrozenCrossReviewArtifact } from '../scripts/evaluate-explanation-cross-review.mjs';

const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const originals = {
  elice: load('../docs/evaluations/explanation-review-elice-2026-11-21.json'),
  gemini: load('../docs/evaluations/explanation-review-gemini-2026-11-21.json'),
};
const fixture = load('./fixtures/explanation-review-cases.json');

test('frozen artifacts tolerate checkout formatting and object-key order but reject data changes', () => {
  const path = 'tests/fixtures/explanation-review-cases.json';
  const reordered = fixture.map((entry: object) => Object.fromEntries(Object.entries(entry).reverse()));
  const formatted = JSON.stringify(reordered, null, 4).replace(/\n/g, '\r\n');
  assert.deepEqual(parseFrozenCrossReviewArtifact(path, formatted), fixture);
  reordered[0].sourceText += ' changed';
  assert.throws(() => parseFrozenCrossReviewArtifact(path, JSON.stringify(reordered)), /artifact changed/);
  assert.throws(() => parseFrozenCrossReviewArtifact('unknown.json', JSON.stringify(fixture)), /artifact changed/);
});

test('cross-review plans reuse only the other provider baseline raw draft with the original shared instruction', () => {
  const before = JSON.stringify({ originals, fixture });
  for (const reviewer of ['elice', 'gemini'] as const) {
    const origin = reviewer === 'elice' ? 'gemini' : 'elice';
    const result = buildCrossReviewPlan(reviewer, originals, fixture);
    assert.equal(result.originalProvider, origin);
    assert.equal(result.instruction, originals.elice.revisionPrompt);
    assert.equal(result.instruction, originals.gemini.revisionPrompt);
    assert.deepEqual(result.plan.map((entry: { caseId: string }) => entry.caseId), ['E-03', 'R-03']);
    for (const entry of result.plan) {
      const baseline = originals[origin].runs.find((run: { caseId: string; arm: string }) => run.caseId === entry.caseId && run.arm === 'baseline');
      assert.equal(entry.originalProvider, origin);
      assert.equal(entry.reviewer, reviewer);
      assert.equal(entry.originalCallId, baseline.callId);
      assert.deepEqual(entry.draftExplanations, JSON.parse(baseline.rawCompletion.text).explanations);
      assert.deepEqual({ sourceText: entry.submittedInput.sourceText, candidates: entry.submittedInput.candidates }, baseline.sentInput);
      entry.draftExplanations[0].explanation = 'mutated returned copy';
      entry.submittedInput.candidates[0].text = 'mutated returned candidate';
    }
  }
  assert.equal(JSON.stringify({ originals, fixture }), before);
});

test('frozen plan rejects changed input, changed prompts, mixed provider provenance and missing/duplicate baselines', () => {
  const changedFixture = structuredClone(fixture);
  changedFixture[0].sourceText += ' 변경';
  assert.throws(() => buildCrossReviewPlan('gemini', originals, changedFixture), /Frozen source or candidate changed/);
  for (const mutate of [
    (r: typeof originals) => { r.elice.provider = 'gemini'; },
    (r: typeof originals) => { r.gemini.revisionPrompt += '\nnew instruction'; },
    (r: typeof originals) => { r.elice.runs = r.elice.runs.filter((run: { arm: string }) => run.arm !== 'baseline'); },
    (r: typeof originals) => { r.elice.runs.push(r.elice.runs[0]); },
    (r: typeof originals) => { r.elice.runs[0].sentInput.sourceText += ' 변경'; },
    (r: typeof originals) => { r.elice.cases[0].candidates[0].text += ' 변경'; },
    (r: typeof originals) => { r.elice.runs[0].status = 503; },
    (r: typeof originals) => { r.elice.runs[0].rawCompletion.finishReason = 'length'; },
  ]) {
    const reports = structuredClone(originals); mutate(reports);
    assert.throws(() => buildCrossReviewPlan('gemini', reports, fixture));
  }
  assert.throws(() => buildCrossReviewPlan('unknown', originals, fixture), /Invalid/);
});

test('baseline draft must retain its frozen prose, exact candidate IDs and strict bounded response schema', () => {
  for (const raw of [
    'not JSON', JSON.stringify({ explanations: [] }),
    JSON.stringify({ explanations: [{ candidateId: 'foreign', explanation: '설명' }] }),
    JSON.stringify({ explanations: [{ candidateId: 'e03-c1', explanation: '가'.repeat(401) }] }),
    JSON.stringify({ explanations: [{ candidateId: 'e03-c1', explanation: 'changed valid prose' }] }),
    JSON.stringify({ explanations: [{ candidateId: 'e03-c1', explanation: '설명', correctLabel: true }] }),
    JSON.stringify({ explanations: [{ candidateId: 'e03-c1', explanation: '설명' }], required: ['answer'] }),
  ]) {
    const reports = structuredClone(originals);
    reports.elice.runs[0].rawCompletion.text = raw;
    assert.throws(() => buildCrossReviewPlan('gemini', reports, fixture));
  }
});

test('cross-review input adds only frozen drafts, excludes fixture answers and leaves source objects unchanged', () => {
  const { plan } = buildCrossReviewPlan('gemini', originals, fixture);
  for (const entry of plan) {
    const submitted = entry.submittedInput;
    const base = { sourceText: submitted.sourceText, candidates: submitted.candidates };
    const before = JSON.stringify({ submitted, base, entry });
    const sent = crossReviewModelInput(base, submitted, entry.draftExplanations, entry.draftSha256);
    assert.deepEqual(Object.keys(sent).sort(), ['candidates', 'draftExplanations', 'sourceText']);
    assert.deepEqual(sent.draftExplanations, entry.draftExplanations);
    assert.equal(Object.hasOwn(sent, 'required'), false);
    assert.equal(Object.hasOwn(sent, 'origin'), false);
    sent.draftExplanations[0].explanation = 'changed returned draft';
    sent.candidates[0].text = 'changed returned candidate';
    assert.equal(JSON.stringify({ submitted, base, entry }), before);
  }
});

test('cross-review input rejects provider input mutation, draft tampering and answer-field injection', () => {
  const { plan: [entry] } = buildCrossReviewPlan('gemini', originals, fixture);
  const submitted = entry.submittedInput;
  const base = { sourceText: submitted.sourceText, candidates: submitted.candidates };
  for (const invalid of [
    { ...base, required: ['answer'] }, { ...base, draftExplanations: entry.draftExplanations },
    { ...base, sourceText: 'changed original' }, { ...base, candidates: [{ ...base.candidates[0], correctLabel: true }] },
  ]) assert.throws(() => crossReviewModelInput(invalid, submitted, entry.draftExplanations, entry.draftSha256), /Unexpected model input/);
  for (const invalid of [
    [{ ...entry.draftExplanations[0], explanation: 'changed valid prose' }],
    [{ ...entry.draftExplanations[0], candidateId: 'foreign' }],
    [{ ...entry.draftExplanations[0], required: ['answer'] }],
    [entry.draftExplanations[0], entry.draftExplanations[0]],
  ]) assert.throws(() => crossReviewModelInput(base, submitted, invalid, entry.draftSha256), /schema, ownership or frozen hash/);
});
