// Manual limited wiring check. No model calls, .env reads or writes without --live.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { createApp } from '../server/app.ts';
import { createGeminiProvider } from '../server/llm/gemini.ts';
import { createEliceProvider } from '../server/llm/elice.ts';
import { correctionInputSchema, correctionOutputSchema, explanationInputSchema } from '../shared/contracts.ts';
import { correctionInstructionFor, explanationInstructionFor } from '../server/llm/prompt.ts';
import { reserveModelCall, finishModelCall } from './lib/model-call-budget.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--provider=gemini', '--provider=elice', '--live'].includes(arg))
  || args.filter(arg => arg.startsWith('--provider=')).length !== 1 || new Set(args).size !== args.length) {
  throw new Error('Usage: node --import tsx scripts/check-requirement-rerun.mjs --provider=gemini|elice [--live]');
}
const providerName = args.find(arg => arg.startsWith('--provider=')).split('=')[1];
const plannedModel = providerName === 'gemini' ? 'gemini-3.5-flash-lite' : 'gpt-4o-mini';
const hash = value => createHash('sha256').update(value).digest('hex');
const cases = [
  { id: 'alternative', phase: 'before_apply', input: {
    requestId: 'rerun-check-alternative', sourceText: '금요일까지 자료를 보내 주세요.',
    retryContext: { requirement: 'alternative', previousSourceText: '금요일까지 자료를 보내 주세요.',
      previousCandidates: [{ id: 'previous-alternative', text: '금요일까지 자료를 보내 주시기 바랍니다.' }] },
  } },
  { id: 'meaning', phase: 'after_apply', input: {
    requestId: 'rerun-check-meaning', sourceText: '목요일에 10명에게 안내합니다.',
    retryContext: { requirement: 'meaning', previousSourceText: '담당자 확인 후 목요일에 8명에게 안내할 예정입니다.',
      previousCandidates: [{ id: 'previous-meaning', text: '목요일에 10명에게 안내합니다.' }] },
  } },
];
for (const entry of cases) correctionInputSchema.parse(entry.input);
const plan = [
  { id: 'alternative-correction', kind: 'correction', caseId: 'alternative' },
  { id: 'meaning-correction', kind: 'correction', caseId: 'meaning' },
  { id: 'meaning-explanation', kind: 'explanation', caseId: 'meaning' },
];
const prompts = Object.fromEntries(plan.map(entry => {
  const context = cases.find(item => item.id === entry.caseId).input.retryContext;
  return [entry.id, entry.kind === 'correction' ? correctionInstructionFor(context) : explanationInstructionFor(context)];
}));
const reportPath = `docs/evaluations/requirement-rerun-${providerName}-2026-11-21.json`;

if (!args.includes('--live')) {
  console.log(JSON.stringify({ dryRun: true, provider: providerName, model: plannedModel, plan, maxCalls: 3,
    totalPlannedAcrossTwoProviders: 6, inputSha256: hash(JSON.stringify(cases)),
    promptSha256: Object.fromEntries(Object.entries(prompts).map(([key, value]) => [key, hash(value)])),
    notes: 'No .env reads, writes or model calls. Explanations use actual successful meaning candidates; no expected answers are sent.' }));
} else {
  const ledgerPath = process.env.MODEL_CALL_LEDGER;
  if (!ledgerPath || !existsSync(ledgerPath)) throw new Error('The existing approved MODEL_CALL_LEDGER is required.');
  if (existsSync(reportPath)) throw new Error('Preserve the existing report; this frozen check cannot overwrite it.');
  const files = ['scripts/check-requirement-rerun.mjs', 'scripts/lib/model-call-budget.mjs', 'shared/contracts.ts',
    'server/app.ts', 'server/llm/prompt.ts', 'server/llm/gemini.ts', 'server/llm/elice.ts',
    'server/llm/parse-explanations.ts', 'server/llm/explanation-check.ts'];
  const report = {
    experimentId: 'requirement-rerun-wiring-20261121', startedAt: new Date().toISOString(),
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    implementationSha256: Object.fromEntries(files.map(path => [path, hash(readFileSync(path))])),
    inputSha256: hash(JSON.stringify(cases)), prompts,
    promptSha256: Object.fromEntries(Object.entries(prompts).map(([key, value]) => [key, hash(value)])),
    provider: providerName, model: plannedModel, cases, plan, modelCalls: 0, maxCalls: 3,
    notes: 'Limited real-provider wiring examples only: not the #22 quality gate, user satisfaction, explanation benefit, or a frequency estimate. No retries or provider substitution. Criteria in the plan are never sent as model input.',
    state: 'preflight', completed: false, runs: [], unexecuted: [...plan],
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const save = () => {
    report.unexecuted = plan.filter(entry => !report.runs.some(run => run.id === entry.id && run.callId));
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  };
  let activeRun = null;
  let server = null;
  const observedFetch = async (url, options) => {
    if (!activeRun || activeRun.callId || report.modelCalls >= plan.length) throw new Error('Unexpected extra model request.');
    const run = activeRun;
    const body = JSON.parse(options.body);
    const instruction = providerName === 'gemini' ? body.systemInstruction.parts.map(part => part.text).join('') : body.messages[0].content;
    if (instruction !== prompts[run.id]) throw new Error('Provider instruction differs from the frozen plan.');
    run.sentInput = JSON.parse(providerName === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content);
    run.sentPromptSha256 = hash(instruction);
    run.requestSettings = providerName === 'gemini' ? body.generationConfig
      : { model: body.model, response_format: body.response_format, n: body.n, stream: body.stream, max_tokens: body.max_tokens };
    options.signal?.throwIfAborted();
    run.callId = reserveModelCall(ledgerPath, { phase: 'development', label: `stage5-${run.id}`, provider: providerName, model: plannedModel });
    report.modelCalls++;
    run.callState = 'pending-result-unknown'; save();
    let response;
    try { response = await fetch(url, options); }
    catch (error) { finishModelCall(ledgerPath, run.callId, { status: 'failed' }); run.callState = 'fetch-failed'; save(); throw error; }
    finishModelCall(ledgerPath, run.callId, { status: 'received', httpStatus: response.status });
    run.callState = 'response-received'; run.upstreamStatus = response.status;
    if (response.ok) {
      try {
        const envelope = await response.clone().json();
        run.rawCompletion = providerName === 'gemini'
          ? { finishReason: envelope.candidates?.[0]?.finishReason,
            text: envelope.candidates?.[0]?.content?.parts?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('') ?? null }
          : { finishReason: envelope.choices?.[0]?.finish_reason, text: envelope.choices?.[0]?.message?.content ?? null };
        const usage = providerName === 'gemini' ? envelope.usageMetadata : envelope.usage;
        const keys = providerName === 'gemini' ? ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount'] : ['prompt_tokens', 'completion_tokens', 'total_tokens'];
        run.tokenUsage = Object.fromEntries(keys.filter(key => typeof usage?.[key] === 'number').map(key => [key, usage[key]]));
      } catch { run.captureError = 'completion-capture-failed'; }
    }
    save(); return response;
  };
  try {
    try { loadEnvFile(process.env.MODEL_ENV_FILE || '.env'); }
    catch { throw new Error('Cannot load the model environment file.'); }
    const model = process.env[providerName === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
    const apiKey = process.env[providerName === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
    const baseUrl = process.env.ELICE_BASE_URL?.trim();
    if (model !== plannedModel || !apiKey || (providerName === 'elice' && !baseUrl)) throw new Error('Provider settings do not match the frozen plan.');
    const provider = providerName === 'gemini' ? createGeminiProvider({ apiKey, model }, observedFetch) : createEliceProvider({ apiKey, model, baseUrl }, observedFetch);
    const observedProvider = { configured: provider.configured,
      async generateCandidates(...args) { const run = activeRun; const output = await provider.generateCandidates(...args); run.adapterCandidates = structuredClone(output); return output; },
      async generateExplanations(...args) { const run = activeRun; const output = await provider.generateExplanations(...args); run.adapterExplanations = structuredClone(output); return output; },
    };
    server = createApp(observedProvider).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    report.state = 'running'; save();
    for (const entry of plan) {
      const current = cases.find(item => item.id === entry.caseId);
      let input = current.input;
      if (entry.kind === 'explanation') {
        const generated = report.runs.find(run => run.id === 'meaning-correction');
        const parsed = correctionOutputSchema.safeParse(generated?.response);
        if (generated?.status !== 200 || !parsed.success) {
          report.runs.push({ ...entry, state: 'skipped', reason: 'meaning-correction-did-not-produce-valid-candidates' }); save(); continue;
        }
        input = explanationInputSchema.parse({ ...current.input, requestId: 'rerun-check-meaning-explanation', candidates: parsed.data.candidates });
      }
      activeRun = { ...entry, input, phase: current.phase, state: 'pending', startedAt: new Date().toISOString() };
      report.runs.push(activeRun); save();
      const started = Date.now();
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${entry.kind === 'correction' ? 'corrections' : 'explanations'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(50_000), body: JSON.stringify(input),
        });
        activeRun.status = response.status; activeRun.response = await response.json();
      } catch { activeRun.transportError = 'local-request-failed'; }
      activeRun.elapsedMs = Date.now() - started; activeRun.state = 'finished'; activeRun.finishedAt = new Date().toISOString(); save();
      console.log(JSON.stringify({ id: activeRun.id, status: activeRun.status, error: activeRun.response?.error?.code ?? activeRun.transportError,
        withheld: activeRun.response?.explanations?.filter(item => 'error' in item).map(item => item.candidateId), modelCalls: report.modelCalls }));
      if (activeRun.transportError || ['MODEL_NOT_CONFIGURED', 'MODEL_CONFIGURATION_ERROR', 'MODEL_QUOTA_EXCEEDED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_REQUEST_FAILED'].includes(activeRun.response?.error?.code)) break;
    }
    report.completed = plan.every(entry => report.runs.some(run => run.id === entry.id && run.state === 'finished' && run.callId));
    report.state = report.completed ? 'finished' : 'stopped';
  } catch {
    report.state = 'stopped'; report.runnerError = 'preflight-or-runner-failed'; process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); save();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  console.log(JSON.stringify({ report: reportPath, state: report.state, completed: report.completed, modelCalls: report.modelCalls, unexecuted: report.unexecuted.map(entry => entry.id) }));
}
