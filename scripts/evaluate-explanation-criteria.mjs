// Manual live evaluation only. Dry run by default; --live makes at most 6 calls.
// Run from the repository root with node --import tsx.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/app.ts';
import { loadLocalProvider } from '../server/llm/config.ts';
import { explanationInstruction } from '../server/llm/prompt.ts';
import { explanationInputSchema } from '../shared/contracts.ts';
import { buildExplanationInput } from '../server/llm/explanation-input.ts';
import { ProviderError } from '../server/llm/provider.ts';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--live' && !arg.startsWith('--cases=')) || args.filter(arg => arg === '--live').length > 1 || args.filter(arg => arg.startsWith('--cases=')).length > 1) throw new Error('Usage: node --import tsx scripts/evaluate-explanation-criteria.mjs [--live] [--cases=path.json]');
const fixturePath = args.find(arg => arg.startsWith('--cases='))?.slice('--cases='.length) || 'tests/fixtures/explanation-criteria-cases.json';
const fixture = readFileSync(fixturePath, 'utf8');
const cases = JSON.parse(fixture);
if (!Array.isArray(cases) || cases.length < 1 || cases.length > 6 || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Expected one to six distinct cases.');
for (const c of cases) explanationInputSchema.parse({ requestId: c.id, sourceText: c.sourceText, candidates: c.candidates });
if (!args.includes('--live')) {
  console.log(JSON.stringify({ dryRun: true, fixturePath, cases: cases.map(c => c.id), candidates: cases.reduce((n,c) => n+c.candidates.length,0), maxCalls: cases.length }));
} else {
  // .env values, raw provider envelopes, credentials and headers are never saved.
  let modelDrafts = null;
  const provider = loadLocalProvider(drafts => { modelDrafts = structuredClone(drafts); });
  if (!provider.configured || !provider.generateExplanations) throw new Error('Configured explanation provider required.');
  const hash = text => createHash('sha256').update(text).digest('hex');
  const startedAt = new Date().toISOString();
  const report = {
    startedAt, codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runnerSha256: hash(readFileSync('scripts/evaluate-explanation-criteria.mjs', 'utf8')),
    fixturePath, fixtureSha256: hash(fixture), provider: process.env.LLM_PROVIDER?.trim(),
    model: (process.env.LLM_PROVIDER?.trim() === 'elice' ? process.env.ELICE_MODEL : process.env.GEMINI_MODEL)?.trim(),
    promptSha256: hash(explanationInstruction), prompt: explanationInstruction, cases,
    outputContractSha256: hash(readFileSync('server/llm/explanation-output.ts', 'utf8')),
    derivedModelInputs: cases.map(c => ({ caseId: c.id, input: buildExplanationInput(c.sourceText, c.candidates) })),
    path: 'Loopback HTTP /api/explanations through createApp and configured provider; no browser.',
    notes: 'Fixed candidates, one request per case; no correction generation, retries or model switching. modelDrafts is a schema/ID-validated snapshot before reference/link checks; not a correctness verdict. Schema-invalid drafts, provider envelopes and headers are not captured. Adapter output is after validation/rendering/identical normalization, before app quote check. E-06 excluded.',
    runs: [],
  };
  mkdirSync('docs/evaluations', { recursive: true });
  const output = `docs/evaluations/criteria-${startedAt.replace(/[:.]/g, '-')}.json`;
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  let captured = null;
  let validationFailure = null;
  const observed = {
    configured: provider.configured,
    generateCandidates: (...args) => provider.generateCandidates(...args),
    async generateExplanations(...args) {
      try {
        const result = await provider.generateExplanations(...args);
        captured = structuredClone(result);
        return result; // No bypass of app validation or quote checks.
      } catch (error) {
        if (error instanceof ProviderError) validationFailure = error.validationFailure ?? null;
        throw error;
      }
    },
  };
  const server = createApp(observed).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  save();
  try {
    for (const [index, c] of cases.entries()) {
      captured = null;
      modelDrafts = null;
      validationFailure = null;
      const run = { id: `RUN-${String(index+1).padStart(2,'0')}`, caseId: c.id, startedAt: new Date().toISOString() };
      const start = Date.now();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/explanations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(50_000),
          body: JSON.stringify({ requestId: run.id, sourceText: c.sourceText, candidates: c.candidates }),
        });
        run.status = response.status;
        run.response = await response.json();
        run.adapterExplanations = captured;
      } catch {
        run.transportError = 'local-request-failed'; // Do not persist unsafe error objects.
        run.adapterExplanations = captured;
      }
      run.validationFailure = validationFailure;
      run.modelDrafts = modelDrafts;
      run.elapsedMs = Date.now()-start;
      report.runs.push(run);
      save();
      console.log(JSON.stringify({ run: run.id, caseId: c.id, status: run.status, error: run.response?.error?.code ?? run.transportError, elapsedMs: run.elapsedMs }));
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
