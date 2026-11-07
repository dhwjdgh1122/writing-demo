// Explicit live evaluation only: never invoked by npm test or server startup.
// Run from the project root: node --import tsx scripts/evaluate-explanations.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { createGeminiProvider } from '../server/llm/gemini.ts';
import { explanationInstruction } from '../server/llm/prompt.ts';

loadEnvFile('.env');
if (process.env.LLM_PROVIDER?.trim() !== 'gemini') throw new Error('Gemini 설정이 필요합니다.');
const config = { apiKey: process.env.GEMINI_API_KEY?.trim() ?? '', model: process.env.GEMINI_MODEL?.trim() ?? '' };
const baseline = readFileSync('tests/fixtures/explanation-v1.txt', 'utf8').trimEnd();
const cases = JSON.parse(readFileSync('tests/fixtures/explanation-cases.json', 'utf8'));
const versions = [{ name: 'before', prompt: baseline }, { name: 'after', prompt: explanationInstruction }];
const report = { startedAt: new Date().toISOString(), model: config.model, notes: 'Same fixed candidates, one request per version/case; not a statistical comparison. Identical candidate text is normalized by application code.',
  prompts: versions.map(v => ({ ...v, sha256: createHash('sha256').update(v.prompt).digest('hex') })), cases, runs: [] };
let stop = false;
for (const item of cases) {
  for (const version of versions) {
    const started = Date.now();
    try {
      // Keep model settings, parsing and validation identical. Only replace the instruction.
      const provider = createGeminiProvider(config, (url, options) => {
        const body = JSON.parse(options.body);
        body.systemInstruction = { parts: [{ text: version.prompt }] };
        return fetch(url, { ...options, body: JSON.stringify(body) });
      });
      const explanations = await provider.generateExplanations(item.sourceText, item.candidates, AbortSignal.timeout(45_000));
      const run = { caseId: item.id, version: version.name, elapsedMs: Date.now() - started, explanations };
      report.runs.push(run);
      console.log(JSON.stringify(run));
    } catch (error) {
      // Do not persist raw upstream errors, credentials or request headers.
      const run = { caseId: item.id, version: version.name, elapsedMs: Date.now() - started, error: error.kind ?? error.name };
      report.runs.push(run); console.log(JSON.stringify(run)); stop = true; break;
    }
  }
  if (stop) break; // No automatic retry, fallback, or further calls after a failure.
}
mkdirSync('docs/evaluations', { recursive: true });
const path = `docs/evaluations/explanations-${report.startedAt.replace(/[:.]/g, '-')}.json`;
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ reportPath: path, calls: report.runs.length, completed: !stop }));
