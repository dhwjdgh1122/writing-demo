// Offline replay of immutable model outputs. Run with --import tsx; no provider,
// environment loader or network request is used. --write preserves a new report.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseExplanations } from '../server/llm/parse-explanations.ts';
import { explanationQuotesMatch } from '../server/llm/explanation-check.ts';

const sourcePath = 'docs/evaluations/explanation-freeform-contrast-2026-11-22-elice.json';
const outputPath = 'docs/evaluations/explanation-spacing-replay-2026-11-22.json';
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceSha256 = sha256(sourcePath);
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const runs = source.runs.filter(run => run.caseId === 'M-01');
assert.equal(runs.length, 2);
const results = runs.map(run => {
  const { sourceText, candidates } = run.submittedInput;
  const raw = JSON.parse(run.rawCompletion.text);
  assert.deepEqual(raw, run.parsedModelOutput);
  const after = parseExplanations(sourceText, candidates, raw).map(item => {
    if ('error' in item) return item;
    const candidate = candidates.find(candidate => candidate.id === item.candidateId);
    return explanationQuotesMatch(sourceText, candidate.text, item.explanation)
      ? item : { candidateId: item.candidateId, error: 'EXPLANATION_QUOTE_MISMATCH' };
  });
  const before = run.response.explanations;
  assert.equal(before.find(item => item.candidateId === 'm01-c1').error, 'EXPLANATION_QUOTE_MISMATCH');
  assert.equal(after.find(item => item.candidateId === 'm01-c1').explanation,
    '공백 5개를 추가하고 4개를 삭제했습니다. 원문 비교에서 공백이 바뀐 위치가 의도에 맞는지 확인해 주세요.');
  for (const id of ['m01-c2', 'm01-c3']) {
    assert.deepEqual(after.find(item => item.candidateId === id), before.find(item => item.candidateId === id));
  }
  return { caseId: run.caseId, arm: run.arm, originalCallId: run.callId, before, after,
    changedCandidateIds: ['m01-c1'], unchangedCandidateIds: ['m01-c2', 'm01-c3'] };
});
assert.equal(sha256(sourcePath), sourceSha256);
const report = {
  method: 'offline-reprocessing-of-preserved-model-output',
  actualModelCalls: 0,
  replayedAt: new Date().toISOString(),
  codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  sourcePath, sourceSha256,
  implementationSha256: Object.fromEntries([
    'scripts/replay-explanation-spacing.mjs', 'server/llm/explanation-spacing.ts',
    'server/llm/parse-explanations.ts', 'server/llm/explanation-check.ts',
  ].map(path => [path, sha256(path)])),
  results,
  limitations: [
    'The original model failures remain failures; only the displayed spacing facts change.',
    'Unchanged candidate 2/3 results still include semantic errors or quote rejection.',
    'No new model generation, grammar/meaning validation or human-effectiveness test.',
  ],
};
if (process.argv.includes('--write')) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ actualModelCalls: 0, preservedSourceSha256: sourceSha256,
  results: results.map(({ arm, changedCandidateIds, unchangedCandidateIds }) => ({ arm, changedCandidateIds, unchangedCandidateIds })),
  written: process.argv.includes('--write') ? outputPath : null }));
