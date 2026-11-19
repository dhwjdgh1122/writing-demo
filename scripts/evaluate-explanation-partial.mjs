// Manual #22 fixed-candidate check. No network or .env access without --live.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/app.ts';
import { createGeminiProvider } from '../server/llm/gemini.ts';
import { createEliceProvider } from '../server/llm/elice.ts';
import { explanationInstruction } from '../server/llm/prompt.ts';
import { explanationInputSchema } from '../shared/contracts.ts';
import { buildEvidenceInput, evidenceInstruction, evidenceResponseSchema, resolveEvidence } from './lib/explanation-evidence-experiment.mjs';
import { contrastExamples, qualityHoldouts } from './lib/explanation-contrast-experiment.mjs';
import { withThinkingLevel, numericTokenUsage } from './lib/explanation-thinking-experiment.mjs';
import { impactInstruction, impactResponseSchema, resolveImpact } from './lib/explanation-impact-experiment.mjs';

const reportedPath = 'tests/fixtures/explanation-reported-quote.json';
const reported = JSON.parse(readFileSync(reportedPath, 'utf8'));
let cases = [
  { id: 'P-01', origin: reported.origin, sourceText: reported.sourceText, candidates: [reported.candidate],
    criteria: ['정확한 근거와 기본형 풀이 구분', '하나였다→유일했다만으로 의미 변화 단정 금지', '실제 수정 설명; 전체 정확성 보증·비한국어 혼입 금지'] },
  { id: 'P-02', origin: '합성 줄바꿈 대조. 팀원 추가 제보는 전체 후보·응답 미확보로 직접 재현 아님.',
    sourceText: '목요일 오후 3시에\n회의를 시작합니다.', candidates: [{ id: 'newline', text: '목요일 오후 3시에\n회의를 진행합니다.' }],
    criteria: ['근거가 줄 경계를 포함하면 실제 줄바꿈 보존', '시작→진행의 초점 차이 설명', '바뀌지 않은 줄바꿈·날짜를 수정했다고 설명하지 않음'] },
  { id: 'P-03', origin: '합성 중요 정보 대조', sourceText: '승인되면 목요일에 15명에게 안내합니다.',
    candidates: [{ id: 'preserved', text: '승인되면 목요일에 15명에게 알려드립니다.' }, { id: 'changed', text: '승인 여부와 관계없이 이후에 안내합니다.' }],
    criteria: ['preserved: 조건·날짜·인원 유지와 표현 차이', 'changed: 승인 조건 반전·목요일 불명확화·15명 누락 모두 설명', 'changed: 원래 정보가 필요한 상황의 선택 기준', '다른 후보의 근거 혼입 금지'] },
  { id: 'P-04', origin: '합성 간단 수정·후보별 공백 대조', sourceText: '금요일까지 자료를 보내 주세여.',
    candidates: [{ id: 'spaced', text: '금요일까지 자료를 보내 주세요.' }, { id: 'joined', text: '금요일까지 자료를 보내주세요.' }],
    criteria: ['각 후보의 실제 공백에 맞는 근거', '오타 수정은 짧게 설명', '날짜·요청 뜻의 변화나 틀린 문법 규칙을 만들지 않음'] },
];
const args = process.argv.slice(2);
const providerName = args.find(a => a.startsWith('--provider='))?.slice(11);
const experiment = args.includes('--evidence-ids');
const contrast = args.includes('--contrast-examples');
const quality = args.includes('--quality-cases');
const thinking = args.find(a => a.startsWith('--thinking='))?.slice(11).toUpperCase();
const impact = args.includes('--impact-fields');
const finalGate = args.includes('--final-gate');
const focusedGate = args.includes('--focused-gate');
const gatePaths = ['tests/fixtures/explanation-criteria-cases.json', 'tests/fixtures/explanation-condition-scope-cases.json', 'tests/fixtures/explanation-usage-boundary-cases.json'];
if (finalGate || focusedGate) {
  const [base, conditions, usage] = gatePaths.map(path => JSON.parse(readFileSync(path, 'utf8')));
  const pick = (items, ids) => ids.map(id => {
    const matches = items.filter(c => c.id === id);
    if (matches.length !== 1) throw new Error('Missing or duplicate fixed gate case: ' + id);
    return matches[0];
  });
  cases = [...pick(base, ['E-01', 'E-02', 'E-03', 'E-04', 'E-05', 'E-07']),
    ...pick(conditions, ['CT-01', 'CT-02', 'CT-03', 'CS-02']), ...pick(usage, ['L-01', 'R-02', 'R-03', 'R-05'])];
  if (cases.length !== 14 || cases.reduce((n, c) => n + c.candidates.length, 0) !== 15) throw new Error('Gate size changed.');
  if (focusedGate) cases = pick(cases, ['E-01', 'E-03', 'E-04', 'CT-01', 'CT-03', 'CS-02', 'R-02', 'R-03', 'R-05']);
}
if (quality) cases = [...cases.filter(c => ['P-03', 'P-04'].includes(c.id)), ...qualityHoldouts];
for (const c of cases) explanationInputSchema.parse({ requestId: c.id, sourceText: c.sourceText, candidates: c.candidates });
const instruction = impact ? impactInstruction(explanationInstruction) : experiment ? evidenceInstruction(explanationInstruction) : explanationInstruction + (contrast ? contrastExamples : '');
if (args.some(a => !['--live', '--final-gate', '--focused-gate', '--evidence-ids', '--contrast-examples', '--quality-cases', '--provider=gemini', '--provider=elice', '--thinking=low', '--thinking=high', '--impact-fields'].includes(a))
  || new Set(args).size !== args.length || args.filter(a => a.startsWith('--provider=')).length > 1
  || args.filter(a => a.startsWith('--thinking=')).length > 1
  || (thinking && (providerName !== 'gemini' || experiment || contrast || !quality))
  || (impact && (thinking || experiment || contrast || !quality))
  || (experiment && (contrast || quality))
  || ((finalGate || focusedGate) && (experiment || contrast || quality || thinking || impact))
  || (finalGate && focusedGate)
  || (args.includes('--live') && !providerName)) throw new Error('Usage: node --import tsx scripts/evaluate-explanation-partial.mjs [--final-gate | --focused-gate | --evidence-ids | --quality-cases [--contrast-examples | --impact-fields]] [--provider=gemini|elice --live]; thinking comparison: --quality-cases --provider=gemini --thinking=low|high [--live]');
const plan = Array.from({ length: finalGate ? 3 : 1 }, (_, i) => cases.map(c => ({ caseId: c.id, repetition: i + 1 }))).flat();
const maxCalls = plan.length;
if (!args.includes('--live')) {
  console.log(JSON.stringify({ dryRun: true, experiment, contrast, quality, thinking, impact, finalGate, focusedGate, cases, plan, maxCallsPerProvider: maxCalls, candidatesPerProvider: cases.reduce((sum, c) => sum + c.candidates.length, 0) * (finalGate ? 3 : 1),
    ...(experiment ? { derivedInputs: cases.map(c => buildEvidenceInput(c.sourceText, c.candidates)) } : {}) }));
} else {
  try { loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read local .env.'); }
  const model = process.env[providerName === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
  const apiKey = process.env[providerName === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
  const baseUrl = process.env.ELICE_BASE_URL?.trim();
  if (!model || !apiKey || (providerName === 'elice' && !baseUrl)) throw new Error('Required provider settings missing.');
  if ((finalGate || focusedGate) && model !== (providerName === 'gemini' ? 'gemini-3.5-flash-lite' : 'gpt-4o-mini')) throw new Error('Gate model differs from fixed criteria.');
  if (thinking && !/^gemini-3[.-]/.test(model)) throw new Error('Thinking comparison requires a Gemini 3 model.');
  let calls = 0;
  let rawCompletion = null;
  let derivedInput = null;
  let mappedCompletion = null;
  let tokenUsage = null;
  let requestSettings = null;
  // Capture only successful completion text and finish reason; never URLs, headers or error bodies.
  const observedFetch = async (...fetchArgs) => {
    if (++calls > maxCalls) throw new Error('Evaluation call limit exceeded.');
    if (experiment) {
      const body = JSON.parse(fetchArgs[1].body);
      const original = JSON.parse(providerName === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content);
      derivedInput = buildEvidenceInput(original.sourceText, original.candidates);
      if (providerName === 'gemini') {
        body.systemInstruction = { parts: [{ text: instruction }] };
        body.contents[0].parts[0].text = JSON.stringify(derivedInput);
        body.generationConfig.responseJsonSchema = evidenceResponseSchema(derivedInput);
      } else {
        body.messages[0].content = instruction;
        body.messages[1].content = JSON.stringify(derivedInput);
      }
      fetchArgs[1] = { ...fetchArgs[1], body: JSON.stringify(body) };
    }
    if (contrast) {
      const body = JSON.parse(fetchArgs[1].body);
      if (providerName === 'gemini') body.systemInstruction = { parts: [{ text: instruction }] };
      else body.messages[0].content = instruction;
      fetchArgs[1] = { ...fetchArgs[1], body: JSON.stringify(body) };
    }
    if (impact) {
      const body = JSON.parse(fetchArgs[1].body);
      if (providerName === 'gemini') {
        const input = JSON.parse(body.contents[0].parts[0].text);
        body.systemInstruction = { parts: [{ text: instruction }] };
        body.generationConfig.responseJsonSchema = impactResponseSchema(input.candidates.map(c => c.id));
      } else body.messages[0].content = instruction;
      fetchArgs[1] = { ...fetchArgs[1], body: JSON.stringify(body) };
    }
    if (thinking) {
      const body = withThinkingLevel(JSON.parse(fetchArgs[1].body), thinking);
      requestSettings = { thinkingLevel: body.generationConfig.thinkingConfig.thinkingLevel,
        maxOutputTokens: body.generationConfig.maxOutputTokens, candidateCount: body.generationConfig.candidateCount };
      fetchArgs[1] = { ...fetchArgs[1], body: JSON.stringify(body) };
    }
    const response = await fetch(...fetchArgs);
    if (response.ok) {
      try {
        const envelope = await response.clone().json();
        if (thinking) tokenUsage = numericTokenUsage(envelope);
        rawCompletion = providerName === 'gemini'
          ? { finishReason: envelope.candidates?.[0]?.finishReason,
              text: envelope.candidates?.[0]?.content?.parts?.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('') ?? null }
          : { finishReason: envelope.choices?.[0]?.finish_reason, text: envelope.choices?.[0]?.message?.content ?? null };
        if ((experiment || impact) && rawCompletion.text && rawCompletion.finishReason === (providerName === 'gemini' ? 'STOP' : 'stop')) {
          // Manual bridge only: keep provider refusal/finish checks and production output validation.
          // Preserve raw completion separately; never repair quotes, ownership or missing prose.
          mappedCompletion = impact ? resolveImpact(JSON.parse(rawCompletion.text)) : resolveEvidence(derivedInput, JSON.parse(rawCompletion.text));
          if (providerName === 'gemini') envelope.candidates[0].content.parts = [{ text: JSON.stringify(mappedCompletion) }];
          else envelope.choices[0].message.content = JSON.stringify(mappedCompletion);
          return Response.json(envelope, { status: response.status });
        }
      } catch { rawCompletion = { ...rawCompletion, captureError: 'completion-not-json-or-unmappable' }; }
    }
    return response;
  };
  const provider = providerName === 'gemini'
    ? createGeminiProvider({ apiKey, model }, observedFetch)
    : createEliceProvider({ apiKey, model, baseUrl }, observedFetch);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const startedAt = new Date().toISOString();
  const report = {
    startedAt, codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    runnerSha256: hash(readFileSync('scripts/evaluate-explanation-partial.mjs', 'utf8')),
    implementationSha256: Object.fromEntries(['server/llm/explanation-check.ts', 'server/llm/explanation-response.ts', 'server/llm/explanation-spacing.ts',
      'server/llm/gemini.ts', 'server/llm/elice.ts', 'server/app.ts', 'shared/contracts.ts']
      .map(path => [path, hash(readFileSync(path, 'utf8'))])),
    reportedFixtureSha256: hash(readFileSync(reportedPath, 'utf8')), casesSha256: hash(JSON.stringify(cases)),
    provider: providerName, model, experiment: impact ? 'impact-fields' : experiment ? 'server-owned-line-evidence-ids' : contrast ? 'contrast-examples' : thinking ? `thinking-${thinking.toLowerCase()}` : null,
    impactModuleSha256: impact ? hash(readFileSync('scripts/lib/explanation-impact-experiment.mjs', 'utf8')) : null,
    thinkingModuleSha256: thinking ? hash(readFileSync('scripts/lib/explanation-thinking-experiment.mjs', 'utf8')) : null,
    caseSet: finalGate ? 'issue22-fixed-14-three-repetitions' : focusedGate ? 'issue22-fixed-nine-focused-single-run' : quality ? 'quality-with-holdouts' : 'original-four',
    ...(finalGate || focusedGate ? { plan, maxCalls, gateSourceCommit: '0e4df1d', fixtureSha256: Object.fromEntries(gatePaths.map(path => [path, hash(readFileSync(path))])),
      reviewContract: 'Reuse fixed required criteria. Legacy notes requirements are assessed in displayed explanation, not a missing legacy JSON field. E-04-p2 must explain retained payment-word misuse. E-05 is server-fixed, excluded from model quality; current production still calls model for that request. No UI guidance counts as satisfying missing explanation content.' } : {}),
    contrastModuleSha256: quality || contrast ? hash(readFileSync('scripts/lib/explanation-contrast-experiment.mjs', 'utf8')) : null,
    experimentModuleSha256: experiment ? hash(readFileSync('scripts/lib/explanation-evidence-experiment.mjs', 'utf8')) : null,
    promptSha256: hash(instruction), prompt: instruction, cases,
    path: impact ? 'Manual visible prose fields → real provider → strict field bridge → unchanged adapter/app validation; NOT deployed service contract; no browser.' : thinking ? 'Manual Gemini thinking-level override only → real provider → unchanged adapter/app validation; NOT deployed service settings; no browser.' : experiment ? 'Manual request/response bridge: server-owned line pairs → real provider IDs → exact pair resolution → unchanged adapter/app validation; NOT deployed service behavior.' : contrast ? 'Manual prompt append only → real provider → unchanged adapter/app validation; NOT deployed service behavior; no browser.' : 'Fixed candidates → loopback /api/explanations → real provider → adapter validation → HTTP result; no browser.',
    notes: 'One call per case per planned repetition, no retries or automatic provider switching. Raw completion text is separate from validated output. HTTP 200 is not semantic correctness. Single AI review is not user validation or a frequency estimate.', runs: [],
  };
  mkdirSync('docs/evaluations', { recursive: true });
  const output = `docs/evaluations/${finalGate ? 'final-gate' : focusedGate ? 'focused-gate' : impact ? 'impact-fields' : thinking ? `thinking-${thinking.toLowerCase()}` : experiment ? 'evidence-ids' : contrast ? 'contrast-examples' : quality ? 'quality-baseline' : 'partial'}-${providerName}-${startedAt.replace(/[:.]/g, '-')}.json`;
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  const server = createApp(provider).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  save();
  try {
    for (const entry of plan) {
      const c = cases.find(c => c.id === entry.caseId);
      rawCompletion = null;
      derivedInput = null;
      mappedCompletion = null;
      tokenUsage = null;
      requestSettings = null;
      const start = Date.now();
      const run = { caseId: c.id, ...(finalGate || focusedGate ? { repetition: entry.repetition } : {}), startedAt: new Date().toISOString() };
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/explanations`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(50_000),
          body: JSON.stringify({ requestId: finalGate ? `${c.id}-r${entry.repetition}` : c.id, sourceText: c.sourceText, candidates: c.candidates }),
        });
        run.status = response.status;
        run.response = await response.json();
        if (response.ok) {
          run.displayed = run.response.explanations.filter(e => 'explanation' in e).map(e => e.candidateId);
          run.withheld = run.response.explanations.filter(e => 'error' in e);
        }
      } catch { run.transportError = 'local-request-failed'; }
      run.rawCompletion = rawCompletion;
      if (thinking) { run.requestSettings = requestSettings; run.tokenUsage = tokenUsage; }
      if (experiment) { run.derivedInput = derivedInput; run.mappedCompletion = mappedCompletion; }
      if (impact) run.mappedCompletion = mappedCompletion;
      run.elapsedMs = Date.now() - start;
      report.runs.push(run);
      save();
      console.log(JSON.stringify({ caseId: c.id, repetition: run.repetition, status: run.status, displayed: run.displayed, withheld: run.withheld,
        error: run.response?.error?.code ?? run.transportError, elapsedMs: run.elapsedMs }));
      if (run.transportError || ['MODEL_NOT_CONFIGURED', 'MODEL_CONFIGURATION_ERROR', 'MODEL_QUOTA_EXCEEDED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_REQUEST_FAILED'].includes(run.response?.error?.code)) break;
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.modelCalls = calls;
    report.completed = report.runs.length === plan.length;
    report.unexecuted = finalGate || focusedGate ? plan.slice(report.runs.length) : plan.slice(report.runs.length).map(c => c.caseId);
    save();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ reportPath: output, modelCalls: calls, completed: report.completed }));
}
