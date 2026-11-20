// Manual paired diagnosis only. Default is dry run, without reading .env or making requests.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/app.ts';
import { createGeminiProvider } from '../server/llm/gemini.ts';
import { createEliceProvider } from '../server/llm/elice.ts';
import { explanationInstruction } from '../server/llm/prompt.ts';
import { explanationInputSchema } from '../shared/contracts.ts';
import { augmentExplanationRequest, buildNumericEvidence, numericEvidenceInstruction } from './lib/explanation-numeric-evidence.ts';

const experimentId = 'issue22-numeric-evidence-v1-20261120';
const fixturePath = 'tests/fixtures/explanation-numeric-cases.json';
const cases = JSON.parse(readFileSync(fixturePath, 'utf8'));
if (cases.length !== 6 || new Set(cases.map(c => c.id)).size !== 6) throw new Error('Expected six fixed distinct cases.');
for (const c of cases) explanationInputSchema.parse({ requestId: c.id, sourceText: c.sourceText, candidates: c.candidates });
const oldCases = JSON.parse(readFileSync('tests/fixtures/explanation-criteria-cases.json', 'utf8'));
for (const id of ['E-03', 'E-01']) {
  const oldCase = oldCases.find(c => c.id === id);
  const current = cases.find(c => c.id === id);
  if (current.sourceText !== oldCase.sourceText || JSON.stringify(current.candidates) !== JSON.stringify(oldCase.candidates)) throw new Error('Existing control changed.');
}
const args = process.argv.slice(2);
if (args.some(arg => !['--live', '--provider=gemini', '--provider=elice'].includes(arg))
  || args.filter(arg => arg.startsWith('--provider=')).length !== 1 || new Set(args).size !== args.length) {
  throw new Error('Usage: node --import tsx scripts/evaluate-explanation-numeric.mjs --provider=gemini|elice [--live]');
}
const providerName = args.find(arg => arg.startsWith('--provider=')).split('=')[1];
const plan = cases.flatMap((c, index) => (index % 2 ? ['numeric', 'baseline'] : ['baseline', 'numeric'])
  .map(version => ({ caseId: c.id, version })));
const maxCalls = plan.length;
const hash = value => createHash('sha256').update(value).digest('hex');
if (!args.includes('--live')) {
  console.log(JSON.stringify({ dryRun: true, experimentId, provider: providerName, plan, maxCalls,
    totalPlannedAcrossTwoProviders: 24, inputs: cases.map(c => ({ caseId: c.id, numericEvidence: buildNumericEvidence(c.sourceText, c.candidates) })) }));
} else {
  mkdirSync('docs/evaluations', { recursive: true });
  // An interrupted or failed run is evidence too. Refuse accidental replay of this frozen experiment.
  for (const name of readdirSync('docs/evaluations').filter(name => name.startsWith(`numeric-evidence-${providerName}-`) && name.endsWith('.json'))) {
    const prior = JSON.parse(readFileSync(`docs/evaluations/${name}`, 'utf8'));
    if (prior.experimentId === experimentId) throw new Error('This provider already has a report for the frozen experiment; preserve it instead of retrying.');
  }
  const plannedModel = providerName === 'gemini' ? 'gemini-3.5-flash-lite' : 'gpt-4o-mini';
  let calls = 0;
  let activeRun = null;
  const observedFetch = async (url, options) => {
    if (!activeRun || calls >= maxCalls) throw new Error('Unexpected model call.');
    const run = activeRun;
    const original = JSON.parse(options.body);
    const body = run.version === 'numeric' ? augmentExplanationRequest(providerName, original) : original;
    const input = JSON.parse(providerName === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content);
    run.sentInput = input;
    run.requestSettings = providerName === 'gemini' ? body.generationConfig
      : { model: body.model, response_format: body.response_format, n: body.n, stream: body.stream, max_tokens: body.max_tokens };
    const requestOptions = { ...options, body: JSON.stringify(body) };
    // Persist before handing off to fetch. If the process stops here, delivery
    // and completion are unknown; this is a conservative attempt count.
    run.modelCallAttempt = ++calls;
    run.modelCallState = 'pending-result-unknown';
    report.modelCalls = calls;
    save();
    let response;
    try { response = await fetch(url, requestOptions); }
    catch (error) {
      run.modelCallState = 'fetch-failed';
      save();
      throw error; // Provider adapters sanitize errors; do not record the raw error.
    }
    run.upstreamStatus = response.status;
    run.modelCallState = 'response-received';
    if (response.ok) {
      try {
        const envelope = await response.clone().json();
        run.rawCompletion = providerName === 'gemini'
          ? { finishReason: envelope.candidates?.[0]?.finishReason,
            text: envelope.candidates?.[0]?.content?.parts?.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('') ?? null }
          : { finishReason: envelope.choices?.[0]?.finish_reason, text: envelope.choices?.[0]?.message?.content ?? null };
        const usage = providerName === 'gemini' ? envelope.usageMetadata : envelope.usage;
        const keys = providerName === 'gemini' ? ['promptTokenCount','candidatesTokenCount','thoughtsTokenCount','totalTokenCount'] : ['prompt_tokens','completion_tokens','total_tokens'];
        run.tokenUsage = Object.fromEntries(keys.filter(k => typeof usage?.[k] === 'number').map(k => [k, usage[k]]));
      } catch { run.captureError = 'completion-capture-failed'; }
    }
    save();
    return response; // Never repair output, bypass checks, or transform a partial completion.
  };
  const startedAt = new Date().toISOString();
  const files = ['scripts/evaluate-explanation-numeric.mjs', 'scripts/lib/explanation-numeric-evidence.ts', fixturePath,
    'server/llm/prompt.ts', 'server/llm/gemini.ts', 'server/llm/elice.ts', 'server/llm/parse-explanations.ts',
    'server/llm/explanation-check.ts', 'server/app.ts', 'shared/contracts.ts'];
  const report = {
    experimentId, startedAt, codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    implementationSha256: Object.fromEntries(files.map(path => [path, hash(readFileSync(path))])),
    provider: providerName, plannedModel, model: null, plan, maxCalls, cases,
    baselinePrompt: explanationInstruction, numericInstructionAppend: numericEvidenceInstruction,
    intervention: 'Computed literal-number evidence plus its interpretation boundaries; same base prompt, output schema, provider settings and API checks. Not a deployed feature.',
    path: 'Fixed candidates -> loopback /api/explanations -> real provider -> unchanged parser and quote checks. No browser or candidate generation.',
    acceptance: 'Diagnostic only: fewer original/candidate number omissions with no new factual error, required-condition/uncertainty/choice omission, control regression or hidden invalid explanation. No improvement or missing pair => no adoption evidence. One sample per arm is not a quality gate.',
    notes: 'Raw completion is distinct from displayed output. No automatic retry/fallback, no discarded failures. Same-case arms are adjacent, order alternates. Human benefit and satisfaction are not measured.',
    state: 'preflight', modelCalls: 0, completed: false, unexecuted: [...plan], runs: [],
    modelCallCounting: 'Persisted immediately before upstream fetch. Pending attempts have unknown delivery and completion; counts do not prove provider execution or billing.',
  };
  const output = `docs/evaluations/numeric-evidence-${providerName}-${startedAt.replace(/[:.]/g, '-')}.json`;
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  save();
  const failPreflight = code => {
    report.state = 'preflight-failed';
    report.preflightError = code;
    report.finishedAt = new Date().toISOString();
    save();
    throw new Error(`Experiment preflight failed: ${code}.`);
  };
  try { loadEnvFile('.env'); } catch { failPreflight('settings-read-failed'); }
  const model = process.env[providerName === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
  const apiKey = process.env[providerName === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
  const baseUrl = process.env.ELICE_BASE_URL?.trim();
  if (!apiKey || !model || (providerName === 'elice' && !baseUrl)) failPreflight('required-settings-missing');
  if (model !== plannedModel) failPreflight('configured-model-mismatch');
  let provider;
  try {
    provider = providerName === 'gemini' ? createGeminiProvider({ apiKey, model }, observedFetch)
      : createEliceProvider({ apiKey, model, baseUrl }, observedFetch);
  } catch { failPreflight('provider-configuration-invalid'); }
  report.model = model;
  report.state = 'running';
  save();
  const server = createApp(provider).listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    for (const entry of plan) {
      const c = cases.find(c => c.id === entry.caseId);
      activeRun = { ...entry, startedAt: new Date().toISOString(), state: 'pending-result-unknown' };
      report.runs.push(activeRun);
      report.unexecuted = plan.slice(report.runs.length);
      save();
      const start = Date.now();
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/explanations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(50_000),
          body: JSON.stringify({ requestId: `${c.id}-${entry.version}`, sourceText: c.sourceText, candidates: c.candidates }),
        });
        activeRun.status = response.status;
        activeRun.response = await response.json();
      } catch { activeRun.transportError = 'local-request-failed'; }
      activeRun.elapsedMs = Date.now() - start;
      activeRun.state = 'finished';
      activeRun.finishedAt = new Date().toISOString();
      save();
      console.log(JSON.stringify({ caseId: c.id, version: entry.version, status: activeRun.status,
        error: activeRun.response?.error?.code ?? activeRun.transportError,
        withheld: activeRun.response?.explanations?.filter(e => 'error' in e).map(e => e.candidateId), elapsedMs: activeRun.elapsedMs }));
      if (activeRun.transportError || ['MODEL_NOT_CONFIGURED','MODEL_CONFIGURATION_ERROR','MODEL_QUOTA_EXCEEDED',
        'MODEL_UNAVAILABLE','MODEL_TIMEOUT','MODEL_REQUEST_FAILED'].includes(activeRun.response?.error?.code)) break;
    }
  } catch {
    report.runnerError = 'runner-failed';
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.modelCalls = calls;
    report.completed = report.runs.length === plan.length && report.runs.every(run => run.state === 'finished');
    report.state = report.completed ? 'completed' : 'stopped';
    report.unexecuted = plan.slice(report.runs.length);
    try { save(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  console.log(JSON.stringify({ reportPath: output, modelCalls: calls, completed: report.completed }));
}
