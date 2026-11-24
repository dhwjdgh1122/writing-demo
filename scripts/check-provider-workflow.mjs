// Manual real-provider check. Dry-run never reads .env, writes artifacts, or calls a model.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import express from 'express';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server/app.ts';
import { createGeminiProvider } from '../server/llm/gemini.ts';
import { createEliceProvider } from '../server/llm/elice.ts';

const args = process.argv.slice(2);
const providerName = args.find(arg => arg.startsWith('--provider='))?.slice(11);
const outputArg = args.find(arg => arg.startsWith('--output='))?.slice(9);
if (!['gemini', 'elice'].includes(providerName) || !outputArg || new Set(args).size !== args.length
  || args.filter(arg => arg.startsWith('--provider=')).length !== 1 || args.filter(arg => arg.startsWith('--output=')).length !== 1
  || args.some(arg => !arg.startsWith('--provider=') && !arg.startsWith('--output=') && arg !== '--live')) {
  throw new Error('Usage: node --import tsx scripts/check-provider-workflow.mjs --provider=gemini|elice --output=<newdirectory> [--live]');
}
const source = '안녕 하세요. 다음주 목요일 오후 3시에 팀 회의를 진행할 예정 입니다.\n참석 가능하신 분들은 수요일 까지 댓글로 알려 주시기바랍니다.\n회의 자료는 미리 읽어보시고, 궁금한점은 따로 적어 주세요.\n참석이 어려우신 분들에게는 회의가 끝난뒤 내용을 공유 하겠습니다.';
const prefix = '선택하지 않은 앞 문장입니다.\n';
const suffix = '\n선택하지 않은 뒤 문장입니다.';
const fixedInput = { requestId: 'provider-workflow-fixed-explanation',
  sourceText: '담당자의 확인을 받은 경우에만 화요일까지 8명에게 자료를 보낼 예정이며, 발송은 확정되지 않았습니다.',
  candidates: [{ id: 'fixed-candidate-1', text: '화요일까지 10명에게 자료를 발송합니다.' }] };
const plan = ['initial-correction', 'initial-explanations', 'expression-selection', 'single-candidate-rerun',
  'apply-candidate', 'switch-candidate', 'applied-rerun', 'fixed-explanation'];
const hash = value => createHash('sha256').update(value).digest('hex');
const maxCalls = 8;
if (!args.includes('--live')) {
  console.log(JSON.stringify({ dryRun: true, provider: providerName, output: outputArg, plan, maxCalls,
    normalPathCalls: 7, inputSha256: hash(JSON.stringify({ source, fixedInput })),
    notes: 'No .env reads, writes or API calls. Live mode uses unchanged provider settings and the built UI; no mocked responses, retries, or provider substitution.' }, null, 2));
} else {
  const output = resolve(outputArg);
  if (existsSync(output)) throw new Error('Output already exists; use a new directory to preserve previous evidence.');
  if (!existsSync('dist/client/index.html')) throw new Error('Build the current client before running this check.');
  mkdirSync(output, { recursive: true });
  const secrets = [];
  const clean = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
  const writeJson = (name, value) => writeFileSync(join(output, name), clean(JSON.stringify(value, null, 2)) + '\n');
  const files = ['scripts/check-provider-workflow.mjs', 'server/app.ts', 'server/llm/prompt.ts', 'server/llm/gemini.ts',
    'server/llm/elice.ts', 'server/llm/parse-explanations.ts', 'server/llm/explanation-check.ts',
    'shared/contracts.ts', 'shared/explanation-changes.ts', 'client/src/App.tsx', 'client/src/state/editor.ts',
    'client/src/components/CorrectionResults.tsx', 'client/src/components/CandidateCard.tsx', 'dist/client/index.html'];
  const report = { experiment: 'issue9-current-provider-workflow', provider: providerName, startedAt: new Date().toISOString(),
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    gitDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    implementationSha256: Object.fromEntries(files.map(file => [file, hash(readFileSync(file))])),
    input: { source, prefix, suffix, fixedInput }, inputSha256: hash(JSON.stringify({ source, fixedInput })),
    plan, maxCalls, modelCalls: 0, calls: [], api: [], steps: [], pageErrors: [], unexecuted: [...plan], state: 'preflight',
    notes: 'One synthetic workflow per provider. HTTP success, valid individual explanations, UI checks, and human quality judgement are distinct. No retry, fallback, .env edits, old ledger edits, or user-effect claim.' };
  let server, browser, page, activeStage = 'preflight', fatal = false;
  const fatalCodes = new Set(['MODEL_NOT_CONFIGURED', 'MODEL_CONFIGURATION_ERROR', 'MODEL_QUOTA_EXCEEDED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_REQUEST_FAILED']);
  const save = () => {
    report.unexecuted = plan.filter(name => !report.steps.some(step => step.name === name));
    writeJson('report.json', report);
  };
  const snapshot = async name => {
    if (!page) return;
    writeJson(`${name}-ui.json`, { editor: await page.getByLabel('원문 입력').inputValue(),
      text: await page.locator('body').innerText(), candidates: await page.locator('.correction-view .candidate-card').evaluateAll(cards => cards.map(card => ({
        text: card.querySelector('.candidate-text')?.textContent, applied: card.classList.contains('is-applied'),
        comparisonOpen: card.querySelector('details')?.open, comparison: card.querySelector('.comparison-content')?.textContent,
        explanation: card.querySelector('.candidate-explanation')?.textContent,
      }))) });
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  };
  const step = async (name, action) => {
    if (fatal) return false;
    activeStage = name;
    const item = { name, startedAt: new Date().toISOString(), state: 'running' };
    report.steps.push(item); save();
    const started = Date.now();
    try { item.observations = await action(); item.state = 'finished'; }
    catch (error) { item.state = 'check-failed'; item.error = clean(error instanceof Error ? error.message : 'Unknown check failure').slice(0, 2000); }
    item.elapsedMs = Date.now() - started;
    try { await snapshot(name); } catch { item.snapshotError = 'UI snapshot unavailable'; }
    save(); console.log(JSON.stringify({ stage: name, state: item.state, modelCalls: report.modelCalls, stopped: fatal }));
    return item.state === 'finished';
  };
  const observedFetch = async (url, options) => {
    if (fatal || report.modelCalls >= maxCalls) throw new Error('Model call safety limit or stop condition reached.');
    options.signal?.throwIfAborted();
    const body = JSON.parse(options.body);
    const instruction = providerName === 'gemini' ? body.systemInstruction.parts.map(part => part.text).join('') : body.messages[0].content;
    const call = { id: report.modelCalls + 1, stage: activeStage, startedAt: new Date().toISOString(), state: 'reserved-before-network',
      input: JSON.parse(providerName === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content),
      promptSha256: hash(instruction), instruction,
      settings: providerName === 'gemini' ? body.generationConfig : { model: body.model, response_format: body.response_format, n: body.n, stream: body.stream, max_tokens: body.max_tokens } };
    report.modelCalls++; report.calls.push(call); writeJson(`call-${String(call.id).padStart(2, '0')}.json`, call); save();
    const started = Date.now();
    try {
      const response = await fetch(url, options);
      call.httpStatus = response.status; call.state = 'received';
      if (response.ok) {
        try {
          const envelope = await response.clone().json();
          call.rawCompletion = providerName === 'gemini' ? {
            text: envelope.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('') ?? null,
            finishReason: envelope.candidates?.[0]?.finishReason, blockReason: envelope.promptFeedback?.blockReason,
          } : { text: envelope.choices?.[0]?.message?.content ?? null, finishReason: envelope.choices?.[0]?.finish_reason };
          const usage = providerName === 'gemini' ? envelope.usageMetadata : envelope.usage;
          call.usage = Object.fromEntries(Object.entries(usage ?? {}).filter(([, value]) => typeof value === 'number'));
        } catch { call.captureError = 'Successful envelope could not be decoded'; }
      }
      return response;
    } catch { call.state = 'transport-failed'; fatal = true; throw new Error('Provider transport failed; no retry attempted.'); }
    finally { call.elapsedMs = Date.now() - started; writeJson(`call-${String(call.id).padStart(2, '0')}.json`, call); save(); }
  };
  try {
    try { loadEnvFile(process.env.MODEL_ENV_FILE || '.env'); }
    catch { throw new Error('Cannot load model environment file.'); }
    for (const [key, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|BASE_URL/.test(key) && value) secrets.push(value);
    const model = process.env[providerName === 'gemini' ? 'GEMINI_MODEL' : 'ELICE_MODEL']?.trim();
    const apiKey = process.env[providerName === 'gemini' ? 'GEMINI_API_KEY' : 'ELICE_API_KEY']?.trim();
    if (!model || !apiKey) throw new Error('Required provider settings are missing.');
    report.model = model;
    const provider = providerName === 'gemini' ? createGeminiProvider({ apiKey, model }, observedFetch)
      : createEliceProvider({ apiKey, model, baseUrl: process.env.ELICE_BASE_URL?.trim() ?? '' }, observedFetch);
    const app = express();
    app.use('/api', (req, res, next) => {
      const started = Date.now();
      const original = res.json.bind(res);
      res.json = body => {
        if (req.method === 'POST') {
          report.api.push({ stage: activeStage, path: req.originalUrl, input: req.body, status: res.statusCode, response: body,
            elapsedMs: Date.now() - started, validExplanations: body.explanations?.filter(item => 'explanation' in item).length,
            invalidExplanations: body.explanations?.filter(item => 'error' in item).length });
          if (fatalCodes.has(body.error?.code)) { fatal = true; report.stopReason = body.error.code; }
          save();
        }
        return original(body);
      };
      next();
    });
    app.use(createApp(provider)); app.use(express.static(resolve('dist/client')));
    server = app.listen(0, '127.0.0.1');
    await new Promise((done, reject) => { server.once('listening', done); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    report.browserVersion = browser.version();
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => { report.pageErrors.push(clean(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 500)); save(); });
    await page.goto(base); report.state = 'running'; save();
    const view = page.locator('.correction-view');
    const cards = view.locator('.candidate-card');
    const texts = () => cards.locator('.candidate-text').allTextContents();
    const editor = page.getByLabel('원문 입력');
    const waitApi = (path, action) => Promise.all([page.waitForResponse(response => response.url() === `${base}/api/${path}`, { timeout: 55_000 }), action()]).then(async ([response]) => ({ status: response.status(), body: await response.json() }));
    const settled = async () => { await expect(view.locator('.loading-message:visible')).toHaveCount(0, { timeout: 55_000 }); };
    const rerun = async (index, requirement) => {
      const toggle = cards.nth(index).getByRole('button', { name: '다시 교정하기', exact: true });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      const controls = cards.nth(index).getByRole('region', { name: '재교정 요청', exact: true });
      await controls.locator(`input[value="${requirement}"]`).check();
      const response = await waitApi('corrections', () => controls.getByRole('button', { name: '교정 시작', exact: true }).click());
      if (response.status === 200) await expect(view.locator('.rerun-controls')).toHaveCount(0);
      else await expect(controls).toHaveAttribute('aria-busy', 'false');
      await settled();
      return response;
    };
    const initialOk = await step('initial-correction', async () => {
      await editor.fill(prefix + source + suffix);
      await editor.evaluate((element, range) => { element.focus(); element.setSelectionRange(...range); }, [prefix.length, prefix.length + source.length]);
      await page.keyboard.press('Shift');
      const response = await waitApi('corrections', () => page.getByRole('button', { name: '교정 실행', exact: true }).click());
      if (response.status !== 200) return { outcome: 'model-failure', status: response.status, code: response.body.error?.code };
      await expect(cards).toHaveCount(3); await expect(editor).toHaveValue(prefix + source + suffix);
      expect(response.body.sourceText).toBe(source);
      return { outcome: 'passed', candidateCount: 3, unchangedEditor: true, selectedRangeOnly: true };
    });
    if (initialOk && await cards.count() === 3 && !fatal) {
      await step('initial-explanations', async () => {
        for (let index = 0; index < 3; index++) await cards.nth(index).locator('.comparison > summary').click();
        const response = await waitApi('explanations', () => view.getByRole('button', { name: '교정 이유', exact: true }).click());
        await settled();
        return { outcome: response.status === 200 ? 'received-see-individual-validity' : 'model-failure', status: response.status,
          valid: response.body.explanations?.filter(item => 'explanation' in item).length ?? 0,
          invalid: response.body.explanations?.filter(item => 'error' in item).length ?? 0 };
      });
      await step('expression-selection', async () => {
        const target = view.locator('.expression-change-candidate').last();
        if (!await target.count()) return { outcome: 'not-exercised', reason: 'No valid linked expression explanation available' };
        const card = target.locator('xpath=ancestor::article');
        const id = await target.getAttribute('data-change-id');
        await target.click();
        await expect(target).toHaveAttribute('aria-pressed', 'true');
        expect(await card.locator(`.expression-change[data-change-id="${id}"]`).evaluateAll(elements => elements.every(element => element.getAttribute('aria-pressed') === 'true'))).toBe(true);
        return { outcome: 'passed', changeId: id, reason: await card.locator('.expression-reason-detail').innerText() };
      });
      await step('single-candidate-rerun', async () => {
        const before = await texts();
        const response = await rerun(2, 'plain');
        expect((await texts()).slice(0, 2)).toEqual(before.slice(0, 2));
        await expect(cards).toHaveCount(3); await expect(editor).toHaveValue(prefix + source + suffix);
        if (response.status === 200) { expect(response.body.candidates).toHaveLength(1); expect(response.body.targetCandidate).toBeDefined(); }
        return { outcome: response.status === 200 ? 'passed' : 'model-failure', siblingsUnchanged: true, status: response.status };
      });
      let applied = -1;
      await step('apply-candidate', async () => {
        const candidates = await texts(); applied = candidates.findIndex(text => text !== source);
        if (applied < 0) return { outcome: 'not-exercised', reason: 'Every candidate identical to source' };
        await cards.nth(applied).getByRole('button', { name: '이 문장 적용', exact: true }).click();
        await expect(editor).toHaveValue(prefix + candidates[applied] + suffix); await expect(cards).toHaveCount(3);
        await expect(cards.nth(applied)).toHaveClass(/is-applied/);
        return { outcome: 'passed', candidateIndex: applied, surroundingPreserved: true };
      });
      await step('switch-candidate', async () => {
        if (applied < 0) return { outcome: 'not-exercised', reason: 'No applied candidate' };
        const candidates = await texts(); const next = candidates.findIndex((text, index) => index !== applied && text !== candidates[applied]);
        if (next < 0) return { outcome: 'not-exercised', reason: 'No textually different candidate to switch to' };
        await cards.nth(next).getByRole('button', { name: '이 후보로 바꾸기', exact: true }).click(); applied = next;
        await expect(editor).toHaveValue(prefix + candidates[next] + suffix); await expect(cards).toHaveCount(3);
        return { outcome: 'passed', candidateIndex: next, surroundingPreserved: true };
      });
      await step('applied-rerun', async () => {
        if (applied < 0) return { outcome: 'not-exercised', reason: 'No applied candidate' };
        const before = await texts(); const document = await editor.inputValue();
        const response = await rerun(applied, 'polite');
        await expect(cards).toHaveCount(3); await expect(editor).toHaveValue(document);
        if (response.status === 200) {
          expect(response.body.candidates).toHaveLength(3); expect(response.body.targetCandidate).toBeUndefined();
          expect(response.body.sourceText).toBe(before[applied]);
          await expect(view.getByRole('button', { name: '교정 이유', exact: true })).toHaveAttribute('aria-expanded', 'true');
          await expect(cards.locator('details[open]')).toHaveCount(3);
        }
        return { outcome: response.status === 200 ? 'passed' : 'model-failure', status: response.status, editorUnchanged: true };
      });
    }
    await step('fixed-explanation', async () => {
      const response = await fetch(`${base}/api/explanations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fixedInput), signal: AbortSignal.timeout(55_000) });
      const body = await response.json();
      return { outcome: response.ok ? 'received-see-individual-validity' : 'model-failure', status: response.status,
        valid: body.explanations?.filter(item => 'explanation' in item).length ?? 0 };
    });
    report.state = fatal ? 'stopped-on-provider-failure' : 'finished';
  } catch (error) { report.state = 'runner-or-preflight-failed'; report.error = clean(error instanceof Error ? error.message : 'Unknown runner failure').slice(0, 1500); }
  finally {
    await browser?.close().catch(() => {});
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    report.finishedAt = new Date().toISOString();
    report.apiSummary = { requests: report.api.length, http200: report.api.filter(item => item.status === 200).length,
      validExplanations: report.api.reduce((sum, item) => sum + (item.validExplanations ?? 0), 0),
      invalidExplanations: report.api.reduce((sum, item) => sum + (item.invalidExplanations ?? 0), 0) };
    save(); console.log(JSON.stringify({ state: report.state, provider: providerName, modelCalls: report.modelCalls, apiSummary: report.apiSummary, unexecuted: report.unexecuted }));
    if (report.state === 'runner-or-preflight-failed') process.exitCode = 1;
  }
}
