// Manual #1/#2 diagnosis. Dry-run by default; bounded calls, no automatic retries.
// Reuses the loopback/observation/report approach of evaluate-explanation-criteria.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../server/app.ts';
import { loadLocalProvider } from '../server/llm/config.ts';
import { correctionInstruction } from '../server/llm/prompt.ts';
import { correctionInputSchema } from '../shared/contracts.ts';

const args = process.argv.slice(2);
if (new Set(args).size !== args.length || args.some(a => !['--live', '--linebreaks', '--baseline', '--revised', '--stability'].includes(a)) || (args.includes('--baseline') && args.includes('--revised'))) throw new Error('Use [--linebreaks --baseline|--revised | --stability] [--live]');
const linebreaks = args.includes('--linebreaks');
const stability = args.includes('--stability');
const phase = args.includes('--baseline') ? 'baseline' : args.includes('--revised') ? 'revised' : null;
if (stability && (linebreaks || phase)) throw new Error('Stability runs use the current prompt without phase flags.');
if ((!linebreaks && phase) || (linebreaks && args.includes('--live') && !phase)) throw new Error('Linebreak live runs require --baseline or --revised.');
const fixturePath = linebreaks ? 'tests/fixtures/linebreak-cases.json' : 'tests/fixtures/correction-coverage-cases.json';
let fixture = readFileSync(fixturePath, 'utf8');
let cases = JSON.parse(fixture);
if (stability) {
  const linebreakFixture = readFileSync('tests/fixtures/linebreak-cases.json', 'utf8');
  cases = [cases.find(c => c.id === 'COV-02'), cases.find(c => c.id === 'COV-03'), JSON.parse(linebreakFixture).find(c => c.id === 'LB-02')];
  fixture = JSON.stringify(cases);
}
const expectedCount = linebreaks ? 6 : 3;
if (cases.length !== expectedCount || new Set(cases.map(c => c.id)).size !== expectedCount) throw new Error('Unexpected case count.');
for (const c of cases) correctionInputSchema.parse({ requestId: c.id, sourceText: c.sourceText });
const plan = stability ? Array.from({ length: 3 }, () => cases).flat() : linebreaks ? cases : [cases[0], cases[0], cases[1], cases[2]];
if (!args.includes('--live')) {
  console.log(JSON.stringify({ dryRun: true, phase, stability, caseIds: plan.map(c => c.id), maxCalls: plan.length, explanationCalls: 0 }));
} else {
  const provider = loadLocalProvider();
  if (!provider.configured) throw new Error('Configured correction provider required.');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const startedAt = new Date().toISOString();
  const report = {
    startedAt, phase, stability, codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runnerSha256: hash(readFileSync('scripts/evaluate-correction-coverage.mjs', 'utf8')),
    fixtureSha256: hash(fixture), promptSha256: hash(correctionInstruction), prompt: correctionInstruction,
    provider: process.env.LLM_PROVIDER?.trim(),
    model: (process.env.LLM_PROVIDER?.trim() === 'elice' ? process.env.ELICE_MODEL : process.env.GEMINI_MODEL)?.trim(),
    path: 'Loopback HTTP /api/corrections -> configured provider adapter -> API; browser replay is separate.',
    notes: 'Full fixture selected (UTF-16 offsets). Adapter strings are schema-validated model output, not raw provider envelopes. No credentials, headers or provider error bodies. No explanation calls/retries/model switching. Coverage requires manual semantic review; line count is not a completeness score.',
    cases, plannedCaseIds: plan.map(c => c.id), runs: [],
  };
  mkdirSync('docs/evaluations', { recursive: true });
  const output = `docs/evaluations/${stability ? 'coverage-stability' : linebreaks ? `linebreaks-${phase}` : 'coverage'}-${startedAt.replace(/[:.]/g, '-')}.json`;
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  let captured = null;
  const observed = { configured: true, async generateCandidates(sourceText, signal) {
    captured = { sourceText };
    const candidates = await provider.generateCandidates(sourceText, signal);
    captured.candidates = structuredClone(candidates);
    return candidates;
  } };
  const server = createApp(observed).listen(0, '127.0.0.1');
  await once(server, 'listening');
  save();
  try {
    for (const [index, c] of plan.entries()) {
      captured = null;
      const run = { id: `COV-RUN-${index + 1}`, caseId: c.id, startedAt: new Date().toISOString(), selection: { start: 0, end: c.sourceText.length } };
      const start = Date.now();
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/corrections`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(50_000),
          body: JSON.stringify({ requestId: run.id, sourceText: c.sourceText }),
        });
        run.status = response.status;
        run.response = await response.json();
      } catch { run.transportError = 'local-request-failed'; }
      run.adapter = captured;
      run.elapsedMs = Date.now() - start;
      if (run.status === 200) {
        run.inputUnchanged = captured?.sourceText === c.sourceText && run.response.sourceText === c.sourceText;
        run.candidatesUnchanged = JSON.stringify(captured?.candidates) === JSON.stringify(run.response.candidates.map(c => c.text));
        run.candidateLineCounts = run.response.candidates.map(c => c.text.split('\n').length);
      }
      report.runs.push(run); save();
      console.log(JSON.stringify({ id: run.id, caseId: c.id, status: run.status, error: run.response?.error?.code ?? run.transportError }));
      if (run.transportError || ['MODEL_NOT_CONFIGURED', 'MODEL_CONFIGURATION_ERROR', 'MODEL_QUOTA_EXCEEDED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_REQUEST_FAILED'].includes(run.response?.error?.code)) break;
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.completed = report.runs.length === plan.length;
    report.unexecuted = plan.slice(report.runs.length).map(c => c.id);
    save(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ reportPath: output, calls: report.runs.length, completed: report.completed }));
}
