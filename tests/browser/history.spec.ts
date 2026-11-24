import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import type { HistoryRecord } from '../../client/src/lib/history';
import { expectSelected, startCorrection } from './selection-helpers';

const storageKey = 'writing-demo.correction-history.v1';
const history = (page: Page) => page.locator('.history-panel');
const correction = (page: Page) => page.locator('.correction-view');

async function openHistory(page: Page) {
  await page.getByRole('button', { name: '교정 이력', exact: true }).click();
  await expect(history(page)).toBeVisible();
  await expect(correction(page)).toBeHidden();
}

async function returnToCorrection(page: Page) {
  await history(page).getByRole('button', { name: '교정 문장으로 돌아가기', exact: true }).click();
  await expect(correction(page)).toBeVisible();
  await expect(history(page)).toBeHidden();
}

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

async function runCorrection(page: Page, text: string) {
  await page.getByLabel('원문 입력').fill(text);
  await selectRange(page, 0, text.length);
  await startCorrection(page);
  await expect(correction(page).locator('.candidate-card')).not.toHaveCount(0);
}

async function savedCount(page: Page, count: number) {
  await expect(history(page).locator('.history-entry')).toHaveCount(count);
  if (count) await expect(history(page).locator('.history-feedback')).toHaveText('이 브라우저에 저장되었습니다.');
}

async function expectExportUnavailable(page: Page) {
  await expect(history(page).getByRole('button', { name: 'JSON 내보내기', exact: true })).toHaveCount(0);
  await expect(history(page)).not.toContainText(/JSON|내보내/);
}

async function exportRecords(page: Page): Promise<{ version: number; records: HistoryRecord[] }> {
  const wasOpen = await history(page).isVisible();
  if (!wasOpen) await openHistory(page);
  const downloadEvent = page.waitForEvent('download');
  await history(page).getByRole('button', { name: 'JSON 내보내기', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^writing-demo-history-\d{4}-\d{2}-\d{2}\.json$/);
  const file = await download.path();
  if (!file) throw new Error('Downloaded history is unavailable');
  const exported = JSON.parse(await readFile(file, 'utf8'));
  if (!wasOpen) await returnToCorrection(page);
  return exported;
}

test.beforeEach(async ({ context }) => {
  await context.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
});

test.describe('explicit history export opt-in', () => {
  test.use({ baseURL: 'http://127.0.0.1:5175' });

  test('exports stored source, candidates, explanations and application metadata and disables an empty export', async ({ page }) => {
    const record: HistoryRecord = {
      id: 'export-record', createdAt: '2026-11-24T01:00:00.000Z', sourceText: '목요일에 안내하겠습니다.',
      candidates: [{ id: 'export-candidate', text: '이후에 안내하겠습니다.' }],
      explanations: [{ candidateId: 'export-candidate', explanation: '목요일이 이후로 바뀌어 안내 날짜가 불분명해졌습니다.' }],
      appliedCandidateId: 'export-candidate', appliedAt: '2026-11-24T01:01:00.000Z',
    };
    await page.addInitScript(({ key, record }) => {
      localStorage.setItem(key, JSON.stringify({ version: 1, records: [record] }));
    }, { key: storageKey, record });
    await page.goto('/');
    await openHistory(page);
    await expect(history(page).locator('.history-notice')).toContainText('내보낸 JSON에도 문장 내용이 포함');
    expect(await exportRecords(page)).toEqual({ version: 1, records: [record] });
    page.once('dialog', dialog => dialog.accept());
    await history(page).getByRole('button', { name: '전체 삭제' }).click();
    await expect(history(page).locator('.history-entry')).toHaveCount(0);
    await expect(history(page).getByRole('button', { name: 'JSON 내보내기', exact: true })).toBeDisabled();
  });
});

test('accepted selection, generated explanation and past application survive refresh as read-only history', async ({ page }) => {
  let correctionCalls = 0;
  let explanationCalls = 0;
  const source = '목요일에 안내하겠습니다.';
  const candidate = '이후에 안내하겠습니다.';
  const explanation = '목요일이 이후로 바뀌어 안내 날짜가 불분명해졌습니다.';
  await page.route('**/api/corrections', async route => {
    correctionCalls++;
    const input = route.request().postDataJSON();
    expect(input.sourceText).toBe(source);
    await route.fulfill({ json: { ...input, candidates: [{ id: 'date', text: candidate }] } });
  });
  await page.route('**/api/explanations', async route => {
    explanationCalls++;
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, explanations: [{ candidateId: 'date', explanation }] } });
  });
  await page.goto('/');
  const surrounding = `앞 문장.\n${source}\n뒤 문장.`;
  await page.getByLabel('원문 입력').fill(surrounding);
  const start = surrounding.indexOf(source);
  await selectRange(page, start, start + source.length);
  await startCorrection(page);
  await savedCount(page, 1);
  expect(explanationCalls).toBe(0);
  await correction(page).getByRole('button', { name: /교정 이유/ }).click();
  await expect(correction(page).locator('.candidate-explanation')).toContainText(explanation);
  await correction(page).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue(surrounding.replace(source, candidate));
  await savedCount(page, 1);
  await expect(history(page).locator('.history-apply-status')).toHaveText('당시 후보 1 적용 기록 있음');
  await page.getByLabel('원문 입력').press('Control+z');
  await expect(page.getByLabel('원문 입력')).toHaveValue(surrounding);
  await expect(history(page).locator('.history-apply-status')).toHaveText('당시 후보 1 적용 기록 있음');
  await page.reload();
  await savedCount(page, 1);
  await expect(page.getByLabel('원문 입력')).toHaveValue('');
  await openHistory(page);
  await history(page).locator('.history-entry > summary').click();
  await expect(history(page).getByRole('region', { name: '교정 요청 당시 원문' })).toHaveText(source);
  await expect(history(page).locator('.candidate-explanation')).toContainText(explanation);
  await expect(history(page).getByText(/현재 글에 그대로 남아 있다는 뜻은 아닙니다/)).toBeVisible();
  await expect(history(page).getByRole('button', { name: '이 문장 적용', exact: true })).toHaveCount(0);
  await expect(history(page).getByRole('button', { name: /교정 이유/ })).toHaveCount(0);
  await history(page).locator('.comparison > summary').click();
  await expect(history(page).locator('.comparison del')).not.toHaveCount(0);
  await expectExportUnavailable(page);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
  expect(stored.version).toBe(1);
  expect(stored.records).toHaveLength(1);
  expect(stored.records[0]).toMatchObject({ sourceText: source, candidates: [{ id: 'date', text: candidate }],
    explanations: [{ candidateId: 'date', explanation }], appliedCandidateId: 'date' });
  expect(stored.records[0].appliedAt).not.toBeNull();
  expect(JSON.stringify(stored)).not.toContain('앞 문장.');
  expect(correctionCalls).toBe(1);
  expect(explanationCalls).toBe(1);
  await page.screenshot({ path: 'test-results/history-saved-readonly.png', fullPage: true });
});

for (const action of ['edit', 'select'] as const) {
  test(`a delayed correction after ${action} is not added to history`, async ({ page }) => {
    const requested = gate();
    const release = gate();
    const delivered = gate();
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON();
      requested.resolve();
      await release.promise;
      await route.fulfill({ json: { ...input, candidates: [{ id: 'late', text: '늦게 도착한 후보' }] } }).catch(() => {});
      delivered.resolve();
    });
    await page.goto('/');
    await page.getByLabel('원문 입력').fill('첫째 둘째');
    await selectRange(page, 0, 2);
    await startCorrection(page);
    await requested.promise;
    if (action === 'edit') await page.getByLabel('원문 입력').fill('완전히 바뀐 원문');
    else await selectRange(page, 3, 5);
    release.resolve();
    await delivered.promise;
    await expect(correction(page).locator('.candidate-card')).toHaveCount(0);
    await expect(history(page).locator('.history-entry')).toHaveCount(0);
    await page.reload();
    await expect(history(page).locator('.history-entry')).toHaveCount(0);
    await openHistory(page);
    await expectExportUnavailable(page);
  });
}

test('failed-only explanation retries preserve the successful explanation in saved history', async ({ page }) => {
  const requests: string[][] = [];
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'first', text: '첫 번째 후보입니다.' }, { id: 'second', text: '두 번째 후보입니다.' }] } });
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON();
    requests.push(input.candidates.map((candidate: { id: string }) => candidate.id));
    if (requests.length === 1) await route.fulfill({ json: { ...input, explanations: [
      { candidateId: 'first', explanation: '먼저 받은 정상 설명입니다.' }, { candidateId: 'second', error: 'EXPLANATION_INVALID' },
    ] } });
    else if (requests.length === 2) await route.fulfill({ status: 503, json: { requestId: input.requestId,
      error: { code: 'MODEL_UNAVAILABLE', message: '테스트용 일시 오류', retryable: true } } });
    else await route.fulfill({ json: { ...input, explanations: [{ candidateId: 'second', explanation: '재시도하여 받은 설명입니다.' }] } });
  });
  await page.goto('/');
  await runCorrection(page, '원문입니다.');
  await correction(page).getByRole('button', { name: /교정 이유/ }).click();
  await expect(correction(page).getByText('먼저 받은 정상 설명입니다.', { exact: true })).toBeVisible();
  await correction(page).getByRole('button', { name: '실패한 설명 다시 시도' }).click();
  await expect(correction(page).getByText('테스트용 일시 오류', { exact: true })).toBeVisible();
  await openHistory(page);
  await history(page).locator('.history-entry > summary').click();
  await expect(history(page).getByText('먼저 받은 정상 설명입니다.', { exact: true })).toBeVisible();
  await returnToCorrection(page);
  await correction(page).getByRole('button', { name: '설명 다시 시도', exact: true }).click();
  await expect(correction(page).getByText('재시도하여 받은 설명입니다.', { exact: true })).toBeVisible();
  await openHistory(page);
  await expect(history(page).getByText('재시도하여 받은 설명입니다.', { exact: true })).toBeVisible();
  await savedCount(page, 1);
  await page.reload();
  await openHistory(page);
  await history(page).locator('.history-entry > summary').click();
  await expect(history(page).locator('.candidate-explanation')).toHaveCount(2);
  await expect(history(page).getByText('먼저 받은 정상 설명입니다.', { exact: true })).toBeVisible();
  await expect(history(page).getByText('재시도하여 받은 설명입니다.', { exact: true })).toBeVisible();
  expect(requests).toEqual([['first', 'second'], ['second'], ['second']]);
});

test('deleting a record while its explanation is pending does not resurrect it', async ({ page }) => {
  const requested = gate();
  const release = gate();
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'pending', text: '교정된 문장입니다.' }] } });
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON();
    requested.resolve();
    await release.promise;
    await route.fulfill({ json: { ...input, explanations: [{ candidateId: 'pending', explanation: '삭제 후 도착한 설명입니다.' }] } });
  });
  await page.goto('/');
  await runCorrection(page, '교정할 문장입니다.');
  await savedCount(page, 1);
  await correction(page).getByRole('button', { name: /교정 이유/ }).click();
  await requested.promise;
  await openHistory(page);
  await history(page).locator('.history-entry > summary').click();
  page.once('dialog', dialog => dialog.dismiss());
  await history(page).getByRole('button', { name: '이 기록 삭제' }).click();
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await history(page).getByRole('button', { name: '이 기록 삭제' }).click();
  await expect(history(page).locator('.history-entry')).toHaveCount(0);
  await expect(history(page).getByRole('heading', { name: /교정 이력/ })).toBeFocused();
  release.resolve();
  await returnToCorrection(page);
  await expect(correction(page).getByText('삭제 후 도착한 설명입니다.', { exact: true })).toBeVisible();
  await expect(history(page).locator('.history-entry')).toHaveCount(0);
  await page.reload();
  await expect(history(page).locator('.history-entry')).toHaveCount(0);
});

test('two tabs share new records and explicit single/all deletions without replacing the other tab record', async ({ page, context }) => {
  await context.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'shared', text: `${input.sourceText} 수정` }] } });
  });
  await page.goto('/');
  const other = await context.newPage();
  await other.goto('/');
  await runCorrection(page, '첫 탭에서 보낸 문장.');
  await savedCount(page, 1);
  await savedCount(other, 1);
  await runCorrection(other, '둘째 탭에서 보낸 문장.');
  await savedCount(other, 2);
  await savedCount(page, 2);
  await openHistory(page);
  const firstRecord = history(page).locator('.history-entry').filter({ hasText: '첫 탭에서 보낸 문장.' });
  await firstRecord.locator(':scope > summary').click();
  page.once('dialog', dialog => dialog.accept());
  await firstRecord.getByRole('button', { name: '이 기록 삭제' }).click();
  await savedCount(page, 1);
  await savedCount(other, 1);
  await expect(history(other).locator('.history-preview')).toHaveText('둘째 탭에서 보낸 문장.');
  await openHistory(other);
  other.once('dialog', dialog => dialog.dismiss());
  await history(other).getByRole('button', { name: '전체 삭제' }).click();
  await expect(history(other).locator('.history-entry')).toHaveCount(1);
  other.once('dialog', dialog => dialog.accept());
  await history(other).getByRole('button', { name: '전체 삭제' }).click();
  await expect(history(other).locator('.history-entry')).toHaveCount(0);
  await expect(history(page).locator('.history-entry')).toHaveCount(0);
  await page.reload();
  await expect(history(page).locator('.history-entry')).toHaveCount(0);
  await expect(page.getByLabel('원문 입력')).toHaveValue('');
  await other.close();
});

test('a storage quota error preserves existing and new records for viewing and a later save retry without export', async ({ page }) => {
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'quota', text: `${input.sourceText} 수정` }] } });
  });
  await page.goto('/');
  await runCorrection(page, '먼저 저장한 문장.');
  await savedCount(page, 1);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    (window as Window & { historyQuota?: boolean }).historyQuota = true;
    Storage.prototype.setItem = function(name, value) {
      if (name === key && (window as Window & { historyQuota?: boolean }).historyQuota) throw new DOMException('Test quota', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, storageKey);
  await runCorrection(page, '저장에 실패한 새 문장.');
  await expect(correction(page).locator('.history-save-warning')).toBeVisible();
  await openHistory(page);
  await expect(history(page).getByText(/변경 내용을 브라우저에 저장하지 못했습니다/)).toBeVisible();
  await expect(history(page).locator('.history-entry')).toHaveCount(2);
  await expectExportUnavailable(page);
  await expect(history(page).locator('.history-preview')).toHaveText(['저장에 실패한 새 문장.', '먼저 저장한 문장.']);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).records.length, storageKey)).toBe(1);
  await page.evaluate(() => { (window as Window & { historyQuota?: boolean }).historyQuota = false; });
  await history(page).getByRole('button', { name: '저장 다시 시도' }).click();
  await savedCount(page, 2);
  await expect(history(page).locator('.history-storage-status')).toHaveCount(0);
  await page.reload();
  await savedCount(page, 2);
  await expect(correction(page).locator('.history-save-warning')).toHaveCount(0);
  await expect(history(page).locator('.history-preview')).toHaveText(['저장에 실패한 새 문장.', '먼저 저장한 문장.']);
});

test('corrupt saved data stays untouched until confirmed reset and new memory records remain viewable without export', async ({ page }) => {
  const invalid = '{broken-history';
  await page.addInitScript(({ key, raw }) => {
    if (!sessionStorage.getItem('history-corrupt-seeded')) {
      localStorage.setItem(key, raw);
      sessionStorage.setItem('history-corrupt-seeded', 'yes');
    }
  }, { key: storageKey, raw: invalid });
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'recovered', text: `${input.sourceText} 수정` }] } });
  });
  await page.goto('/');
  await openHistory(page);
  await expect(history(page).getByText(/기존 교정 이력을 읽지 못해 자동 저장을 중단했습니다/)).toBeVisible();
  await returnToCorrection(page);
  await runCorrection(page, '현재 화면에만 남은 문장.');
  await openHistory(page);
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(invalid);
  await expectExportUnavailable(page);
  await expect(history(page).locator('.history-preview')).toHaveText('현재 화면에만 남은 문장.');
  page.once('dialog', async dialog => {
    expect(dialog.message()).not.toMatch(/JSON|내보내/);
    await dialog.dismiss();
  });
  await history(page).getByRole('button', { name: '이력 저장소 초기화' }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(invalid);
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await history(page).getByRole('button', { name: '이력 저장소 초기화' }).click();
  await expect(history(page).locator('.history-entry')).toHaveCount(0);
  await expect(history(page).locator('.history-storage-status')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await returnToCorrection(page);
  await runCorrection(page, '초기화 후 새로 저장한 문장.');
  await savedCount(page, 1);
  await page.reload();
  await savedCount(page, 1);
  await expect(history(page).locator('.history-preview')).toHaveText('초기화 후 새로 저장한 문장.');
});

test('unsupported safe storage warns about memory-only records without offering unavailable export', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'memory', text: '고친 문장.' }] } });
  });
  await page.goto('/');
  await runCorrection(page, '입력한 문장.');
  await openHistory(page);
  await expect(history(page).getByText(/현재 페이지에서만 보관합니다/)).toBeVisible();
  await expectExportUnavailable(page);
  await expect(history(page).locator('.history-preview')).toHaveText('입력한 문장.');
  await expect(history(page).getByRole('button', { name: '저장 다시 시도' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await page.reload();
  await expect(history(page).locator('.history-entry')).toHaveCount(0);
});

test('history remains keyboard operable without horizontal overflow on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const source = Array.from({ length: 30 }, (_, index) => `${index + 1}. 줄바꿈과 공백  두 칸을 확인합니다.`).join('\n');
  const record: HistoryRecord = { id: 'keyboard-record', createdAt: '2026-11-21T01:00:00.000Z', sourceText: source,
    candidates: [{ id: 'keyboard-candidate', text: `${source}\n확인했습니다.` }],
    explanations: [{ candidateId: 'keyboard-candidate', explanation: '마지막에 확인 문장을 추가했습니다.' }], appliedCandidateId: null, appliedAt: null };
  await page.addInitScript(({ key, record }) => { localStorage.setItem(key, JSON.stringify({ version: 1, records: [record] })); }, { key: storageKey, record });
  let modelRequests = 0;
  page.on('request', request => { if (/\/api\/(corrections|explanations)$/.test(request.url())) modelRequests++; });
  await page.goto('/');
  await savedCount(page, 1);
  await openHistory(page);
  const summary = history(page).locator('.history-entry > summary');
  await summary.focus();
  await summary.press('Enter');
  await expect(history(page).locator('.history-entry')).toHaveAttribute('open', '');
  const sourceRegion = history(page).getByRole('region', { name: '교정 요청 당시 원문' });
  // Native details opens before onToggle mounts the React content.
  await expect(sourceRegion).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(sourceRegion).toBeFocused();
  expect(await sourceRegion.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await sourceRegion.press('Control+End');
  await expect.poll(() => sourceRegion.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Tab');
  const compare = history(page).locator('.comparison > summary');
  await expect(compare).toBeFocused();
  await compare.press('Space');
  await expect(history(page).locator('.comparison')).toHaveAttribute('open', '');
  await expect(history(page).locator('textarea,input,[contenteditable="true"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const remove = history(page).getByRole('button', { name: '이 기록 삭제' });
  await remove.focus();
  page.once('dialog', dialog => dialog.dismiss());
  await remove.press('Enter');
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  expect(modelRequests).toBe(0);
  await page.screenshot({ path: 'test-results/history-keyboard-mobile.png', fullPage: true });
});

test('history navigation preserves the current selection, candidates, comparison and cached explanation', async ({ page }) => {
  const source = '목요일에 안내하겠습니다.';
  const candidate = '이후에 안내하겠습니다.';
  const explanation = '목요일이 이후로 바뀌어 안내 날짜가 불분명해졌습니다.';
  let corrections = 0;
  let explanations = 0;
  await page.route('**/api/corrections', async route => {
    corrections++;
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'preserved', text: candidate }] } });
  });
  await page.route('**/api/explanations', async route => {
    explanations++;
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, explanations: [{ candidateId: 'preserved', explanation }] } });
  });
  await page.goto('/');
  const document = `앞 문장은 바꾸지 않습니다.\n${source}\n뒤 문장도 바꾸지 않습니다.`;
  const start = document.indexOf(source);
  await page.getByLabel('원문 입력').fill(document);
  await selectRange(page, start, start + source.length);
  await startCorrection(page);
  await expect(correction(page).locator('.candidate-text')).toHaveText(candidate);
  await correction(page).locator('.comparison > summary').click();
  const explanationButton = correction(page).getByRole('button', { name: '교정 이유', exact: true });
  await expect(explanationButton).toHaveAttribute('aria-expanded', 'false');
  const closedColor = await explanationButton.evaluate(element => getComputedStyle(element).backgroundColor);
  await explanationButton.click();
  await expect(correction(page).locator('.candidate-explanation')).toContainText(explanation);
  await expect(explanationButton).toHaveAttribute('aria-expanded', 'true');
  expect(await explanationButton.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(closedColor);
  await savedCount(page, 1);
  await openHistory(page);
  await history(page).locator('.history-entry > summary').click();
  await expect(history(page).locator('.candidate-explanation')).toContainText(explanation);
  await expect(page.getByLabel('원문 입력')).toHaveValue(document);
  await returnToCorrection(page);
  await expect(page.getByRole('button', { name: '교정 이력', exact: true })).toBeFocused();
  await expect(correction(page).locator('.candidate-text')).toHaveText(candidate);
  await expect(correction(page).locator('.comparison')).toHaveAttribute('open', '');
  await expect(explanationButton).toHaveAttribute('aria-expanded', 'true');
  await expect(correction(page).locator('.candidate-explanation')).toBeVisible();
  await expectSelected(page, source);
  expect(await page.getByLabel('원문 입력').evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]))
    .toEqual([start, start + source.length]);
  await explanationButton.click();
  await expect(explanationButton).toHaveAttribute('aria-expanded', 'false');
  await explanationButton.click();
  await expect(correction(page).locator('.candidate-explanation')).toContainText(explanation);
  await correction(page).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue(document.replace(source, candidate));
  expect(corrections).toBe(1);
  expect(explanations).toBe(1);
});

test('an explanation finishes while history is open and returning does not request it again', async ({ page }) => {
  const requested = gate();
  const release = gate();
  let explanationCalls = 0;
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'pending-navigation', text: '자료를 보내 주세요.' }] } });
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON();
    explanationCalls++;
    requested.resolve();
    await release.promise;
    await route.fulfill({ json: { ...input, explanations: [{ candidateId: 'pending-navigation', explanation: '주세여를 주세요로 고쳤습니다.' }] } });
  });
  await page.goto('/');
  await runCorrection(page, '자료를 보내 주세여.');
  await correction(page).getByRole('button', { name: '교정 이유', exact: true }).click();
  await requested.promise;
  await openHistory(page);
  await history(page).locator('.history-entry > summary').click();
  release.resolve();
  await expect(history(page).locator('.candidate-explanation')).toContainText('주세여를 주세요로 고쳤습니다.');
  await returnToCorrection(page);
  await expect(correction(page).getByRole('button', { name: '교정 이유', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(correction(page).locator('.candidate-explanation')).toBeVisible();
  await expect(correction(page).locator('.candidate-explanation')).toContainText('주세여를 주세요로 고쳤습니다.');
  expect(explanationCalls).toBe(1);
});

test('history is keyboard accessible before any correction and returning preserves the draft', async ({ page }) => {
  let requests = 0;
  page.on('request', request => { if (/\/api\/(corrections|explanations)$/.test(request.url())) requests++; });
  await page.goto('/');
  await page.getByLabel('원문 입력').fill('아직 교정하지 않은 작성 중인 글입니다.');
  await expect(history(page)).toBeHidden();
  await expect(correction(page).getByRole('button', { name: '교정 이유', exact: true })).toHaveCount(0);
  const entry = page.getByRole('button', { name: '교정 이력', exact: true });
  await entry.focus();
  await entry.press('Enter');
  await expect(history(page)).toBeVisible();
  await expect(history(page).getByRole('button', { name: '교정 문장으로 돌아가기', exact: true })).toBeFocused();
  await expect(history(page).locator('.history-empty')).toBeVisible();
  await expectExportUnavailable(page);
  await history(page).getByRole('button', { name: '교정 문장으로 돌아가기', exact: true }).press('Enter');
  await expect(entry).toBeFocused();
  await expect(page.getByLabel('원문 입력')).toHaveValue('아직 교정하지 않은 작성 중인 글입니다.');
  expect(requests).toBe(0);
});

for (const width of [1440, 390]) {
  test(`history uses the result panel, equal action buttons and its own scroll area at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const records: HistoryRecord[] = Array.from({ length: 12 }, (_, index) => ({
      id: `layout-record-${index}`, createdAt: '2026-11-21T01:00:00.000Z',
      sourceText: `${index + 1}번째 저장된 원문입니다. 긴주소${'a'.repeat(100)}`,
      candidates: [{ id: `layout-candidate-${index}`, text: `${index + 1}번째 저장된 후보입니다.` }],
      explanations: [], appliedCandidateId: null, appliedAt: null,
    }));
    await page.addInitScript(({ key, records }) => localStorage.setItem(key, JSON.stringify({ version: 1, records })), { key: storageKey, records });
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON();
      await route.fulfill({ json: { ...input, candidates: [{ id: 'layout-current', text: '지금 교정한 후보입니다.' }] } });
    });
    await page.goto('/');
    await runCorrection(page, '현재 교정할 원문입니다.');
    const buttons = correction(page).locator('.panel-action');
    await expect(buttons).toHaveText(['교정 이력', '교정 이유']);
    await expect(correction(page).locator('.result-count')).toHaveCount(0);
    const sizes = await buttons.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      const icon = element.querySelector('svg')!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, iconWidth: icon.width, iconHeight: icon.height };
    }));
    for (const size of sizes) expect(size).toMatchObject({ width: 160, height: 40, iconWidth: 18, iconHeight: 18 });
    expect(sizes[0].x).toBe(sizes[1].x);
    expect(sizes[1].y).toBeGreaterThan(sizes[0].y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/history-entry-buttons-${width}.png`, fullPage: true });
    await openHistory(page);
    await expect(page.locator('.correction-panel > .history-panel')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const scrollArea = history(page).locator('.history-scroll');
    await expect(scrollArea).toBeVisible();
    expect(await scrollArea.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const header = history(page).locator('.history-heading');
    const before = await header.boundingBox();
    await scrollArea.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => scrollArea.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const after = await header.boundingBox();
    expect(after?.y).toBeCloseTo(before!.y, 1);
    const panelBox = await page.locator('.correction-panel').boundingBox();
    const historyBox = await history(page).boundingBox();
    expect(historyBox!.width).toBeLessThanOrEqual(panelBox!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/history-panel-layout-${width}.png`, fullPage: true });
  });
}
