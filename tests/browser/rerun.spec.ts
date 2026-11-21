import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Candidate, CorrectionInput, ExplanationInput } from '../../shared/contracts';
import type { HistoryRecord } from '../../client/src/lib/history';
import type { ActivityEvent } from '../../client/src/lib/activity';
import { startCorrection } from './selection-helpers';

const results = (page: Page) => page.locator('.correction-panel');
const history = (page: Page) => page.locator('.history-panel:not(.activity-panel)');
const activity = (page: Page) => page.locator('.activity-panel');
const rerun = (page: Page) => page.getByRole('region', { name: '재교정 요청', exact: true });
const requirement = (page: Page) => rerun(page).getByRole('combobox', { name: /이번에는 어떤 점을 바꾸고 싶나요/ });
const rerunButton = (page: Page) => rerun(page).getByRole('button', { name: '다시 교정하기', exact: true });
const explanationText = '테스트에서 주입한 교정 설명입니다.';
const failureText = '테스트용 교정 오류: 로그에 보관하면 안 되는 상세 문구';

type ExportedActivity = {
  version: number; contentIncluded: boolean;
  events: (ActivityEvent & { content?: Pick<HistoryRecord, 'sourceText' | 'candidates' | 'explanations'> })[];
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function selectRange(page: Page, start: number, end: number) {
  await page.getByLabel('원문 입력').evaluate((element: HTMLTextAreaElement, range) => {
    element.focus(); element.setSelectionRange(range[0], range[1]);
  }, [start, end]);
  await page.keyboard.press('Shift');
}

async function firstCorrection(page: Page, text: string, selection = text) {
  await page.getByLabel('원문 입력').fill(text);
  const start = text.indexOf(selection);
  await selectRange(page, start, start + selection.length);
  await startCorrection(page);
  await expect(results(page).locator('.candidate-card')).not.toHaveCount(0);
  await expect(rerun(page)).toBeVisible();
}

async function mockModels(page: Page, outputs: (string[] | 'failure')[], beforeReply?: (input: CorrectionInput, index: number) => Promise<void>) {
  const corrections: CorrectionInput[] = [];
  const explanations: ExplanationInput[] = [];
  const candidates: Candidate[][] = [];
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON() as CorrectionInput;
    corrections.push(input);
    const index = corrections.length - 1;
    if (beforeReply) await beforeReply(input, index);
    const output = outputs[index];
    if (!output) throw new Error(`Unexpected correction request ${index + 1}`);
    if (output === 'failure') {
      candidates[index] = [];
      await route.fulfill({ status: 503, json: { requestId: input.requestId,
        error: { code: 'MODEL_UNAVAILABLE', message: failureText, retryable: true } } }).catch(() => {});
    } else {
      candidates[index] = output.map((text, candidateIndex) => ({ id: `candidate-${index + 1}-${candidateIndex + 1}`, text }));
      await route.fulfill({ json: { ...input, candidates: candidates[index] } }).catch(() => {});
    }
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    explanations.push(input);
    await route.fulfill({ json: { ...input, explanations: input.candidates.map(candidate => ({ candidateId: candidate.id, explanation: explanationText })) } });
  });
  return { corrections, explanations, candidates };
}

async function downloadText(page: Page, panel: Locator, button: string) {
  const pending = page.waitForEvent('download');
  await panel.getByRole('button', { name: button, exact: true }).click();
  const download = await pending;
  const file = await download.path();
  if (!file) throw new Error('Download file is unavailable');
  return readFile(file, 'utf8');
}

async function historyRecords(page: Page): Promise<HistoryRecord[]> {
  return JSON.parse(await downloadText(page, history(page), 'JSON 내보내기')).records;
}

async function activityRecords(page: Page): Promise<ExportedActivity> {
  return JSON.parse(await downloadText(page, activity(page), '행동 JSON 내보내기'));
}

// Read exported CSV as a spreadsheet would, including quoted commas, newlines and quotes.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') { row.push(field); field = ''; }
    else if (!quoted && character === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (quoted || character !== '\r') field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map(columns => Object.fromEntries(headers.map((name, index) => [name, columns[index]])));
}

test.beforeEach(async ({ context }) => {
  await context.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
});

test('before application, an optional requirement reaches new candidates and a later explanation with the same context', async ({ page }) => {
  const source = '금요일까지 자료를 보내 주세여.';
  const calls = await mockModels(page, [['금요일까지 자료를 보내 주세요.', '금요일까지 자료를 전달해 주세요.'], ['자료를 금요일까지 보내 주시겠어요?']]);
  await page.goto('/');
  const document = `선택하지 않은 앞 문장.\n${source}\n선택하지 않은 뒤 문장.`;
  await firstCorrection(page, document, source);
  await requirement(page).selectOption('alternative');
  await expect(requirement(page)).toHaveValue('alternative');
  expect(calls.corrections).toHaveLength(1);
  expect(calls.explanations).toHaveLength(0);
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('자료를 금요일까지 보내 주시겠어요?');
  expect(calls.corrections[1]).toMatchObject({ sourceText: source, retryContext: {
    requirement: 'alternative', previousSourceText: source, previousCandidates: calls.candidates[0],
  } });
  expect(calls.corrections[1].requestId).not.toBe(calls.corrections[0].requestId);
  await expect(page.getByLabel('원문 입력')).toHaveValue(document);
  expect(calls.explanations).toHaveLength(0);
  await results(page).getByRole('button', { name: /교정 이유/ }).click();
  await expect(results(page).locator('.candidate-explanation')).toContainText(explanationText);
  expect(calls.explanations).toHaveLength(1);
  expect(calls.explanations[0]).toMatchObject({ sourceText: source, candidates: calls.candidates[1], retryContext: calls.corrections[1].retryContext });
  const records = await historyRecords(page);
  expect(records).toHaveLength(2);
  expect(records.find(record => record.id === calls.corrections[1].requestId)).toMatchObject({ parentRecordId: calls.corrections[0].requestId, sourceText: source });
  const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
  expect(events.find(event => event.action === 'correction_requested')).toMatchObject({ parentRequestId: calls.corrections[0].requestId, phase: 'before_apply', requirement: 'alternative' });
  expect(events.filter(event => event.action === 'explanation_requested')).toHaveLength(1);
  expect(events.filter(event => event.action === 'explanation_received')).toHaveLength(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/rerun-desktop.png', fullPage: true });
});

test('after application, rerun corrects the currently applied text and retains the previous request as context', async ({ page }) => {
  const source = '자료 보내 주세여.';
  const applied = '자료를 보내 주세요.';
  const next = '자료를 보내 주시면 감사하겠습니다.';
  const calls = await mockModels(page, [[applied], [next]]);
  await page.goto('/');
  await firstCorrection(page, `앞.\n${source}\n뒤.`, source);
  await results(page).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue(`앞.\n${applied}\n뒤.`);
  await requirement(page).selectOption('polite');
  expect(calls.corrections).toHaveLength(1);
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText(next);
  expect(calls.corrections[1]).toMatchObject({ sourceText: applied, retryContext: {
    requirement: 'polite', previousSourceText: source, previousCandidates: calls.candidates[0],
  } });
  await results(page).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue(`앞.\n${next}\n뒤.`);
  const records = await historyRecords(page);
  expect(records.find(record => record.id === calls.corrections[1].requestId)).toMatchObject({ sourceText: applied,
    parentRecordId: calls.corrections[0].requestId, appliedCandidateId: calls.candidates[1][0].id });
  const events = (await activityRecords(page)).events;
  expect(events.find(event => event.requestId === calls.corrections[1].requestId && event.action === 'correction_requested')).toMatchObject({
    parentRequestId: calls.corrections[0].requestId, phase: 'after_apply', requirement: 'polite',
  });
  expect(events.filter(event => event.action === 'candidate_applied')).toHaveLength(2);
});

test('skipping the optional requirement makes a normal request without leaking an earlier choice', async ({ page }) => {
  const calls = await mockModels(page, [['첫 후보입니다.'], ['다른 후보입니다.']]);
  await page.goto('/');
  await firstCorrection(page, '원문입니다.');
  await requirement(page).selectOption('meaning');
  await requirement(page).selectOption('');
  expect(calls.corrections).toHaveLength(1);
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('다른 후보입니다.');
  expect(Object.keys(calls.corrections[1]).sort()).toEqual(['requestId', 'sourceText']);
  expect(calls.corrections[1].sourceText).toBe('원문입니다.');
  const record = (await historyRecords(page)).find(value => value.id === calls.corrections[1].requestId);
  expect(record?.parentRecordId).toBe(calls.corrections[0].requestId);
  const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
  expect(events.find(event => event.action === 'correction_requested')).toMatchObject({ parentRequestId: calls.corrections[0].requestId, phase: 'before_apply' });
  expect(events.every(event => event.requirement === undefined)).toBe(true);
});

for (const change of ['edit', 'selection'] as const) {
  test(`${change} invalidates the previous rerun context and the next ordinary request has no requirement or parent`, async ({ page }) => {
    const calls = await mockModels(page, [['첫 줄의 후보.'], ['새 요청 후보.']]);
    await page.goto('/');
    const document = '첫째 문장.\n둘째 문장.';
    await firstCorrection(page, document, '첫째 문장.');
    await requirement(page).selectOption('plain');
    const nextSource = change === 'edit' ? '직접 고친 원문.' : '둘째 문장.';
    if (change === 'edit') {
      await page.getByLabel('원문 입력').fill(nextSource);
      await selectRange(page, 0, nextSource.length);
    } else {
      const start = document.indexOf(nextSource);
      await selectRange(page, start, start + nextSource.length);
    }
    await expect(rerun(page)).toHaveCount(0);
    expect(calls.corrections).toHaveLength(1);
    await startCorrection(page);
    await expect(results(page).locator('.candidate-text')).toHaveText('새 요청 후보.');
    expect(calls.corrections[1].sourceText).toBe(nextSource);
    expect(calls.corrections[1].retryContext).toBeUndefined();
    expect((await historyRecords(page)).find(record => record.id === calls.corrections[1].requestId)?.parentRecordId).toBeUndefined();
  });
}

test('a failed rerun retains its original context for retry and stores only a safe failure code', async ({ page }) => {
  const calls = await mockModels(page, [['처음 받은 후보.'], 'failure', ['다시 받은 후보.']]);
  await page.goto('/');
  await firstCorrection(page, '오류가 있는 원문.');
  await requirement(page).selectOption('errors');
  await rerunButton(page).click();
  await expect(results(page).getByText(failureText, { exact: true })).toBeVisible();
  await expect(rerunButton(page)).toBeEnabled();
  await expect(requirement(page)).toHaveValue('errors');
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('다시 받은 후보.');
  expect(calls.corrections[2].sourceText).toBe(calls.corrections[1].sourceText);
  expect(calls.corrections[2].retryContext).toEqual(calls.corrections[1].retryContext);
  const records = await historyRecords(page);
  expect(records).toHaveLength(2);
  expect(records.some(record => record.id === calls.corrections[1].requestId)).toBe(false);
  expect(records.find(record => record.id === calls.corrections[2].requestId)?.parentRecordId).toBe(calls.corrections[0].requestId);
  const exported = await activityRecords(page);
  expect(exported.events.find(event => event.requestId === calls.corrections[1].requestId && event.action === 'correction_failed')).toMatchObject({ errorCode: 'MODEL_UNAVAILABLE' });
  expect(JSON.stringify(exported)).not.toContain(failureText);
});

test('editing during a rerun discards the late result without adding history or recording a received result', async ({ page }) => {
  const requested = gate();
  const release = gate();
  const calls = await mockModels(page, [['기존 후보.'], ['늦은 재교정 후보.']], async (_input, index) => {
    if (index === 1) { requested.resolve(); await release.promise; }
  });
  await page.goto('/');
  await firstCorrection(page, '처음 입력한 원문.');
  await requirement(page).selectOption('alternative');
  await rerunButton(page).click();
  await requested.promise;
  await page.getByLabel('원문 입력').fill('기다리다가 바꾼 원문.');
  await expect(rerun(page)).toHaveCount(0);
  release.resolve();
  await expect(results(page).locator('.candidate-card')).toHaveCount(0);
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
  expect(events.filter(event => event.action === 'correction_cancelled')).toHaveLength(1);
  expect(events.some(event => event.action === 'correction_received')).toBe(false);
  await page.reload();
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
});

test('a rerun response with a different requirement echo is rejected instead of being saved under the requested choice', async ({ page }) => {
  const calls = await mockModels(page, [['기존 후보.']]);
  await page.goto('/');
  await firstCorrection(page, '요구를 확인할 원문.');
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON() as CorrectionInput;
    calls.corrections.push(input);
    await route.fulfill({ json: { ...input, retryContext: { ...input.retryContext, requirement: 'plain' },
      candidates: [{ id: 'wrong-echo', text: '요구가 잘못 연결된 후보.' }] } });
  });
  await requirement(page).selectOption('polite');
  await rerunButton(page).click();
  await expect(results(page).locator('.error-message')).toBeVisible();
  await expect(results(page).locator('.candidate-card')).toHaveCount(0);
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  expect((await historyRecords(page)).some(record => record.id === calls.corrections[1].requestId)).toBe(false);
});

test('activity JSON/CSV omit all text by default and opt-in content joins only history that still exists', async ({ page }) => {
  const source = '비공개 예시 원문, 첫 줄.\n둘째 줄을 확인해 주세여.';
  const first = '비공개 예시 후보, 첫 줄.\n둘째 줄을 확인해 주세요.';
  const second = '비공개 예시 재교정 후보,\n둘째 줄도 확인 부탁드립니다.';
  const calls = await mockModels(page, [[first], [second]]);
  await page.goto('/');
  await firstCorrection(page, source);
  await results(page).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await requirement(page).selectOption('polite');
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText(second);
  await results(page).getByRole('button', { name: /교정 이유/ }).click();
  await expect(results(page).locator('.candidate-explanation')).toContainText(explanationText);
  await expect(activity(page).getByRole('checkbox', { name: '문장 내용 포함' })).not.toBeChecked();
  const defaultJsonText = await downloadText(page, activity(page), '행동 JSON 내보내기');
  const defaultCsv = await downloadText(page, activity(page), '행동 CSV 내보내기');
  const defaultJson = JSON.parse(defaultJsonText) as ExportedActivity;
  expect(defaultJson.contentIncluded).toBe(false);
  expect(defaultJson.events.length).toBeGreaterThan(0);
  expect(defaultJson.events.every(event => !('content' in event))).toBe(true);
  for (const text of [source, first, second, explanationText]) {
    expect(defaultJsonText).not.toContain(JSON.stringify(text).slice(1, -1));
    expect(defaultCsv).not.toContain(text);
  }
  const defaultRows = parseCsv(defaultCsv);
  expect(defaultRows).toHaveLength(defaultJson.events.length);
  expect(defaultRows.every(row => !('sourceText' in row) && !('candidates' in row) && !('explanations' in row))).toBe(true);
  await activity(page).getByRole('checkbox', { name: '문장 내용 포함' }).check();
  const withContent = await activityRecords(page);
  expect(withContent.contentIncluded).toBe(true);
  expect(withContent.events.find(event => event.requestId === calls.corrections[0].requestId)?.content?.sourceText).toBe(source);
  expect(withContent.events.find(event => event.requestId === calls.corrections[1].requestId)?.content).toMatchObject({ sourceText: first,
    candidates: calls.candidates[1], explanations: [{ candidateId: calls.candidates[1][0].id, explanation: explanationText }] });
  const withContentRows = parseCsv(await downloadText(page, activity(page), '행동 CSV 내보내기'));
  expect(withContentRows.find(row => row.requestId === calls.corrections[1].requestId)?.sourceText).toBe(first);
  expect(JSON.parse(withContentRows.find(row => row.requestId === calls.corrections[1].requestId)!.candidates)).toEqual(calls.candidates[1]);
  const oldRecord = history(page).locator('.history-entry').filter({ has: page.locator('.history-preview', { hasText: '비공개 예시 원문' }) });
  await oldRecord.locator(':scope > summary').click();
  page.once('dialog', dialog => dialog.accept());
  await oldRecord.getByRole('button', { name: '이 기록 삭제' }).click();
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  const afterDelete = await activityRecords(page);
  expect(afterDelete.events.map(event => event.id)).toEqual(withContent.events.map(event => event.id));
  expect(afterDelete.events.filter(event => event.requestId === calls.corrections[0].requestId).every(event => !event.content)).toBe(true);
  expect(afterDelete.events.filter(event => event.requestId === calls.corrections[1].requestId).every(event => event.content?.sourceText === first)).toBe(true);
});

test('participant edits affect future events only after apply and deleting activity leaves correction history intact', async ({ page }) => {
  const calls = await mockModels(page, [['첫 후보.'], ['둘째 후보.'], ['셋째 후보.']]);
  await page.goto('/');
  await activity(page).getByLabel('참여자 코드', { exact: true }).fill('T01');
  await activity(page).getByRole('button', { name: '참여자 코드 적용' }).click();
  await firstCorrection(page, '참여자 검증 원문.');
  await activity(page).getByLabel('참여자 코드', { exact: true }).fill('T02');
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('둘째 후보.');
  await activity(page).getByRole('button', { name: '참여자 코드 적용' }).click();
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('셋째 후보.');
  const exported = await activityRecords(page);
  expect(exported.events.filter(event => event.requestId !== calls.corrections[2].requestId).every(event => event.participantCode === 'T01')).toBe(true);
  expect(exported.events.filter(event => event.requestId === calls.corrections[2].requestId).every(event => event.participantCode === 'T02')).toBe(true);
  expect(new Set(exported.events.map(event => event.id)).size).toBe(exported.events.length);
  await page.reload();
  await expect(activity(page).getByLabel('참여자 코드', { exact: true })).toHaveValue('T02');
  expect((await activityRecords(page)).events).toEqual(exported.events);
  page.once('dialog', dialog => dialog.dismiss());
  await activity(page).getByRole('button', { name: '행동 기록 전체 삭제' }).click();
  expect((await activityRecords(page)).events).toHaveLength(exported.events.length);
  page.once('dialog', dialog => dialog.accept());
  await activity(page).getByRole('button', { name: '행동 기록 전체 삭제' }).click();
  await expect(activity(page).getByRole('button', { name: '행동 JSON 내보내기' })).toBeDisabled();
  await expect(history(page).locator('.history-entry')).toHaveCount(3);
  await page.reload();
  await expect(activity(page).getByRole('button', { name: '행동 JSON 내보내기' })).toBeDisabled();
  await expect(history(page).locator('.history-entry')).toHaveCount(3);
});

test('activity quota failure keeps both saved and new events exportable and can recover without losing history', async ({ page }) => {
  const key = 'writing-demo.activity.v1';
  const calls = await mockModels(page, [['저장된 첫 후보.'], ['저장 재시도가 필요한 후보.']]);
  await page.goto('/');
  await firstCorrection(page, '저장 오류를 확인할 원문.');
  const original = await activityRecords(page);
  await expect.poll(async () => page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!).events.length, key)).toBe(original.events.length);
  await page.evaluate(storageKey => {
    const setItem = Storage.prototype.setItem;
    (window as Window & { activityQuota?: boolean }).activityQuota = true;
    Storage.prototype.setItem = function(name, value) {
      if (name === storageKey && (window as Window & { activityQuota?: boolean }).activityQuota) throw new DOMException('Test quota', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  }, key);
  await requirement(page).selectOption('alternative');
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('저장 재시도가 필요한 후보.');
  await expect(activity(page).getByText(/행동 기록을 저장하지 못했습니다/)).toBeVisible();
  const inMemory = await activityRecords(page);
  expect(inMemory.events.length).toBeGreaterThan(original.events.length);
  expect(inMemory.events.some(event => event.requestId === calls.corrections[1].requestId && event.action === 'correction_received')).toBe(true);
  expect(await page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!).events.length, key)).toBe(original.events.length);
  await expect(history(page).locator('.history-entry')).toHaveCount(2);
  await page.evaluate(() => { (window as Window & { activityQuota?: boolean }).activityQuota = false; });
  await activity(page).getByRole('button', { name: '행동 기록 저장 다시 시도' }).click();
  await expect(activity(page).locator('.history-storage-status')).toHaveCount(0);
  await page.reload();
  expect((await activityRecords(page)).events).toEqual(inMemory.events);
  await expect(history(page).locator('.history-entry')).toHaveCount(2);
});

test('corrupt activity bytes are preserved while current events remain exportable until explicit reset', async ({ page }) => {
  const key = 'writing-demo.activity.v1';
  const invalid = '{unreadable-activity';
  await page.addInitScript(({ storageKey, value }) => {
    if (!sessionStorage.getItem('activity-corrupt-seeded')) {
      localStorage.setItem(storageKey, value);
      sessionStorage.setItem('activity-corrupt-seeded', 'yes');
    }
  }, { storageKey: key, value: invalid });
  const calls = await mockModels(page, [['현재 창에서 받은 후보.']]);
  await page.goto('/');
  await expect(activity(page).getByText(/저장된 행동 기록을 읽을 수 없어/)).toBeVisible();
  await firstCorrection(page, '손상된 기록과 별개의 원문.');
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe(invalid);
  const memory = await activityRecords(page);
  expect(memory.events.some(event => event.requestId === calls.corrections[0].requestId && event.action === 'correction_received')).toBe(true);
  page.once('dialog', dialog => dialog.dismiss());
  await activity(page).getByRole('button', { name: '행동 기록 저장소 초기화' }).click();
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe(invalid);
  expect((await activityRecords(page)).events).toEqual(memory.events);
  page.once('dialog', dialog => dialog.accept());
  await activity(page).getByRole('button', { name: '행동 기록 저장소 초기화' }).click();
  await expect(activity(page).getByRole('button', { name: '행동 JSON 내보내기' })).toBeDisabled();
  await expect(activity(page).locator('.history-storage-status')).toHaveCount(0);
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  await expect(page.getByLabel('원문 입력')).toHaveValue('손상된 기록과 별개의 원문.');
  await page.reload();
  await expect(activity(page).getByRole('button', { name: '행동 JSON 내보내기' })).toBeDisabled();
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
});

test('requirement selection and rerun are keyboard operable on a narrow screen without extra requests', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await mockModels(page, [['처음 보여준 후보.'], ['뜻을 유지한 새 후보.']]);
  await page.goto('/');
  await firstCorrection(page, '원래 뜻을 유지할 원문.');
  const choice = requirement(page);
  await choice.focus();
  await choice.press('Home');
  for (let index = 0; index < 4; index++) await choice.press('ArrowDown');
  await expect(choice).toHaveValue('meaning');
  expect(calls.corrections).toHaveLength(1);
  await page.keyboard.press('Tab');
  await expect(rerunButton(page)).toBeFocused();
  await rerunButton(page).press('Enter');
  await expect(results(page).locator('.candidate-text')).toHaveText('뜻을 유지한 새 후보.');
  expect(calls.corrections[1].retryContext?.requirement).toBe('meaning');
  expect(calls.explanations).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/rerun-keyboard-mobile.png', fullPage: true });
});
