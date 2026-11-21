// Explicit manual experiment. Dry-run is the default; never part of CI/server startup.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createEliceProvider } from '../server/llm/elice.ts';
import { correctionInstruction } from '../server/llm/prompt.ts';
import { correctionInputSchema } from '../shared/contracts.ts';
import { reserveModelCall, finishModelCall } from './lib/model-call-budget.mjs';

const experimentId = 'correction-output-limit-20261121';
const reportPath = `docs/evaluations/${experimentId}.json`;
const cases = [
  { id: 'L-01', sourceText: Array.from({ length: 9 }, (_, i) => `${i + 1}번 준비반은 금요일 오후 3시까지 자료 8개를 검토해 주세여. 담당자의 승인을 받은 경우에만 토요일에 결과를 보내며, 승인을 받지 못하면 발송하지 않슴니다.`).join('\n') },
  { id: 'L-02', sourceText: Array.from({ length: 8 }, (_, i) => `${i + 1}번 상담실 이용 안내를 드림니다. 운영 시간은 오전 9시부터 오후 6시까지이며, 예약을 취소하려면 목요일까지 알려 주세여. 신청자가 12명 미만인 경우에만 추가 신청을 받을 예정이고, 일정은 아직 확정되지 않았슴니다.`).join('\n\n') },
  { id: 'S-01', sourceText: '담당자의 확인을 받은 경우에만 금요일까지 8명에게 자료를 보내 주세여. 확인되지 않으면 보내지 마세여.' },
];
for (const c of cases) correctionInputSchema.parse({ requestId: c.id, sourceText: c.sourceText });
const plan = [
  { caseId: 'L-01', arm: 'baseline' }, { caseId: 'L-01', arm: 'single' },
  { caseId: 'L-02', arm: 'single' }, { caseId: 'L-02', arm: 'baseline' },
  { caseId: 'S-01', arm: 'single' },
];
const singleInstruction = correctionInstruction.replace('자연스러운 교정 후보를 최대 3개 만드세요. 적절한 대안이 부족하면 1~2개만 반환하세요.',
  '선택 원문 전체를 빠짐없이 교정한 후보 1개만 반환하세요. 여러 대안을 만들지 마세요.');
if (singleInstruction === correctionInstruction) throw new Error('Baseline instruction changed; review this frozen experiment.');
const args = process.argv.slice(2);
if (args.some(a => a !== '--live') || args.length > 1) throw new Error('Usage: node --import tsx scripts/evaluate-correction-limit.mjs [--live]');
if (!args.includes('--live')) {
  console.log(JSON.stringify({ dryRun: true, experimentId, maxCalls: 5, plan, cases: cases.map(c => ({ id: c.id, characters: Array.from(c.sourceText).length })) }));
} else {
  const ledgerPath = process.env.MODEL_CALL_LEDGER;
  if (!ledgerPath) throw new Error('MODEL_CALL_LEDGER is required for this approved run.');
  if (existsSync(reportPath)) throw new Error('Preserve the existing report; do not replay this experiment.');
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const report = { experimentId, startedAt: new Date().toISOString(), codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    fileHashes: Object.fromEntries(['server/llm/elice.ts','server/llm/prompt.ts', 'scripts/evaluate-correction-limit.mjs', 'scripts/lib/model-call-budget.mjs'].map(p => [p, hash(p)])),
    provider: 'elice', model: 'gpt-4o-mini', baselineInstruction: correctionInstruction, singleInstruction, cases, plan,
    acceptance: 'Synthetic long Korean inputs: completed valid whole candidate; all numbered items, dates, numbers, conditions, negation and manual lines retained. Short control also retained. One run per arm is diagnosis, not a population success rate. No model/ceiling changes or automatic retry.',
    runs: [], unexecuted: [...plan], state: 'preflight', modelCalls: 0 };
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  let active;
  const observedFetch = async (url, options) => {
    if (!active || report.modelCalls >= plan.length) throw new Error('Unexpected call.');
    const body = JSON.parse(options.body);
    body.messages[0].content = active.arm === 'single' ? singleInstruction : correctionInstruction;
    active.settings = { model: body.model, max_tokens: body.max_tokens, n: body.n, stream: body.stream };
    active.callId = reserveModelCall(ledgerPath, { phase: 'development', label: `stage1-${active.caseId}-${active.arm}`, provider: 'elice', model: report.model });
    report.modelCalls++;
    active.callState = 'pending';
    save();
    let response;
    try { response = await fetch(url, { ...options, body: JSON.stringify(body) }); }
    catch (e) { finishModelCall(ledgerPath, active.callId, { status: 'failed' }); active.callState = 'failed'; save(); throw e; }
    finishModelCall(ledgerPath, active.callId, { status: 'received', httpStatus: response.status });
    active.callState = 'received'; active.httpStatus = response.status;
    if (response.ok) {
      const envelope = await response.clone().json();
      active.finishReason = envelope.choices?.[0]?.finish_reason;
      active.rawText = envelope.choices?.[0]?.message?.content;
      active.usage = Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(k => typeof envelope.usage?.[k] === 'number').map(k => [k, envelope.usage[k]]));
    }
    save();
    return response;
  };
  try {
    loadEnvFile('.env');
    if (process.env.ELICE_MODEL?.trim() !== report.model) throw new Error('Configuration mismatch.');
    const provider = createEliceProvider({ apiKey: process.env.ELICE_API_KEY ?? '', model: report.model, baseUrl: process.env.ELICE_BASE_URL ?? '' }, observedFetch);
    report.state = 'running'; save();
    for (const entry of plan) {
      active = { ...entry, startedAt: new Date().toISOString() }; report.runs.push(active);
      report.unexecuted = plan.slice(report.runs.length); save();
      const c = cases.find(c => c.id === entry.caseId);
      try {
        active.candidates = await provider.generateCandidates(c.sourceText, AbortSignal.timeout(45_000));
        active.candidateChecks = active.candidates.map(text => ({
          lines: text.split('\n').length, sourceLines: c.sourceText.split('\n').length,
          numbers: text.match(/\d+/g), sourceNumbers: c.sourceText.match(/\d+/g),
        }));
        active.outcome = 'valid-output';
      } catch (error) { active.outcome = error?.kind ?? 'transport-or-runner-failure'; }
      active.finishedAt = new Date().toISOString(); save();
      console.log(JSON.stringify({ caseId: active.caseId, arm: active.arm, outcome: active.outcome, finishReason: active.finishReason, candidates: active.candidates?.length, modelCalls: report.modelCalls }));
      if (!['valid-output','invalid','truncated','blocked'].includes(active.outcome)) break;
    }
    report.state = report.runs.length === plan.length ? 'completed' : 'stopped';
  } catch { report.state = 'configuration-or-runner-failed'; process.exitCode = 1; }
  finally { report.finishedAt = new Date().toISOString(); save(); }
  console.log(JSON.stringify({ reportPath, modelCalls: report.modelCalls, state: report.state, unexecuted: report.unexecuted.length }));
}
