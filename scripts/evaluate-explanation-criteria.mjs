// Manual live evaluation only. Dry run by default; --live makes at most 6 calls.
// Run from the repository root with node --import tsx.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/app.ts';
import { loadLocalProvider } from '../server/llm/config.ts';
import { explanationInstruction } from '../server/llm/prompt.ts';
import { explanationInputSchema } from '../shared/contracts.ts';

const fixturePath = 'tests/fixtures/explanation-criteria-cases.json';
const fixture = readFileSync(fixturePath, 'utf8');
const cases = JSON.parse(fixture);
if (cases.length !== 6 || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Expected six distinct cases.');
for (const c of cases) explanationInputSchema.parse({ requestId: c.id, sourceText: c.sourceText, candidates: c.candidates });
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--live') || args.length > 1) throw new Error('Usage: node --import tsx scripts/evaluate-explanation-criteria.mjs [--live]');
if (!args.includes('--live')) {
  console.log(JSON.stringify({ dryRun: true, cases: cases.map(c => c.id), candidates: cases.reduce((n,c) => n+c.candidates.length,0), maxCalls: 6, skipped: 'E-06: incomplete original evidence' }));
} else {
  // .env values, raw provider envelopes, credentials and headers are never saved.
  const provider = loadLocalProvider();
  if (!provider.configured || !provider.generateExplanations) throw new Error('Configured explanation provider required.');
  const hash = text => createHash('sha256').update(text).digest('hex');
  const startedAt = new Date().toISOString();
  const report = {
    startedAt, codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runnerSha256: hash(readFileSync('scripts/evaluate-explanation-criteria.mjs', 'utf8')),
    fixtureSha256: hash(fixture), provider: process.env.LLM_PROVIDER?.trim(),
    model: (process.env.LLM_PROVIDER?.trim() === 'elice' ? process.env.ELICE_MODEL : process.env.GEMINI_MODEL)?.trim(),
    promptSha256: hash(explanationInstruction), prompt: explanationInstruction, cases,
    path: 'Loopback HTTP /api/explanations through createApp and configured provider; no browser.',
    notes: 'Fixed candidates, one request per case; no correction generation, retries or model switching. Adapter output is after schema validation and identical-text normalization, before app quote check. Not raw model output. E-06 excluded.',
    runs: [],
  };
  mkdirSync('docs/evaluations', { recursive: true });
  const output = `docs/evaluations/criteria-${startedAt.replace(/[:.]/g, '-')}.json`;
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  let captured = null;
  const observed = {
    configured: provider.configured,
    generateCandidates: (...args) => provider.generateCandidates(...args),
    async generateExplanations(...args) {
      const result = await provider.generateExplanations(...args);
      captured = structuredClone(result);
      return result; // No bypass of app validation or quote checks.
    },
  };
  const server = createApp(observed).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  save();
  try {
    for (const [index, c] of cases.entries()) {
      captured = null;
      const run = { id: `RUN-${String(index+1).padStart(2,'0')}`, caseId: c.id, startedAt: new Date().toISOString() };
      const start = Date.now();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/explanations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(50_000),
          body: JSON.stringify({ requestId: run.id, sourceText: c.sourceText, candidates: c.candidates }),
        });
        run.status = response.status;
        run.response = await response.json();
        if (response.ok) {
          run.displayed = run.response.explanations.filter(e => 'explanation' in e).map(e => e.candidateId);
          run.withheld = run.response.explanations.filter(e => 'error' in e).map(e => ({ candidateId: e.candidateId, error: e.error }));
        }
        run.adapterExplanations = captured;
      } catch {
        run.transportError = 'local-request-failed'; // Do not persist unsafe error objects.
        run.adapterExplanations = captured;
      }
      run.elapsedMs = Date.now()-start;
      report.runs.push(run);
      save();
      console.log(JSON.stringify({ run: run.id, caseId: c.id, status: run.status, displayed: run.displayed, withheld: run.withheld, error: run.response?.error?.code ?? run.transportError, elapsedMs: run.elapsedMs }));
      // Continue on case-specific invalid output/quote mismatch; stop on availability/quota/configuration failures.
      if (run.transportError || ['MODEL_NOT_CONFIGURED','MODEL_CONFIGURATION_ERROR','MODEL_QUOTA_EXCEEDED','MODEL_UNAVAILABLE','MODEL_TIMEOUT','MODEL_REQUEST_FAILED'].includes(run.response?.error?.code)) break;
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.completed = report.runs.length === cases.length;
    report.unexecuted = cases.slice(report.runs.length).map(c => c.id);
    save();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ reportPath: output, requests: report.runs.length, completed: report.completed }));
}
