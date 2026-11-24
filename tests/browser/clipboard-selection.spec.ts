import { expect, test, type Page } from '@playwright/test';
import type { CorrectionInput, ExplanationInput } from '../../shared/contracts';
import { expectSelected, startCorrection } from './selection-helpers';

// Use the browser's clipboard and native paste command. fill() only prepares
// the initial document; it does not stand in for the paste under examination.
// Set CLIPBOARD_BROWSER_CHANNEL=chrome for a second installed-browser check.
const channel = process.env.CLIPBOARD_BROWSER_CHANNEL === 'chrome' ? 'chrome' : 'msedge';
test.use({ channel, permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeAll(async ({ browser }) => {
  console.info(`Issue #7 clipboard check: ${channel} ${browser.version()}`);
});

const editor = (page: Page) => page.getByLabel('원문 입력');
const cards = (page: Page) => page.locator('.correction-view .candidate-card');
const run = (page: Page) => page.getByRole('button', { name: '교정 실행', exact: true });
const explanation = '클립보드 범위 검사용 설명입니다.';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function selectRange(page: Page, start: number, end: number) {
  await editor(page).evaluate((element: HTMLTextAreaElement, range) => {
    element.focus();
    element.setSelectionRange(range[0], range[1]);
  }, [start, end]);
  await page.keyboard.press('Shift');
}

async function paste(page: Page, text: string) {
  await page.bringToFront();
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await editor(page).evaluate(element => {
    element.removeAttribute('data-test-paste');
    element.addEventListener('paste', event => {
      const pasteEvent = event as ClipboardEvent;
      element.setAttribute('data-test-paste', JSON.stringify({
        text: pasteEvent.clipboardData?.getData('text/plain'), trusted: pasteEvent.isTrusted,
      }));
    }, { once: true });
  });
  await editor(page).press('Control+v');
  // Windows supplies CRLF in the clipboard event; textarea values use LF.
  // Keep the raw event evidence and normalize only this comparison.
  await expect.poll(async () => {
    const event = JSON.parse(await editor(page).getAttribute('data-test-paste') ?? 'null') as { text?: string; trusted: boolean } | null;
    return event && { ...event, text: event.text?.replace(/\r\n/g, '\n') };
  }).toEqual({ text, trusted: true });
}

async function mockModels(page: Page, beforeReply?: (input: CorrectionInput, index: number) => Promise<void>) {
  const corrections: CorrectionInput[] = [];
  const explanations: ExplanationInput[] = [];
  await page.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON() as CorrectionInput;
    corrections.push(input);
    const requestNumber = corrections.length;
    if (beforeReply) await beforeReply(input, requestNumber - 1);
    await route.fulfill({ json: { ...input, candidates: [1, 2, 3].map(index => ({
      id: `paste-${requestNumber}-${index}`, text: `${input.sourceText} (대안 ${index})`,
    })) } }).catch(() => {});
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    explanations.push(input);
    await route.fulfill({ json: { ...input, explanations: input.candidates.map(candidate => ({
      candidateId: candidate.id, explanation,
    })) } });
  });
  return { corrections, explanations };
}

test('same whole-document clipboard paste keeps the explicitly selected whole range', async ({ page }) => {
  const requests = await mockModels(page);
  const source = '앞😀 문장.\n금요일까지 자료를 보내 주세요.\n끝 문장.';
  await page.goto('/');
  await editor(page).fill(source);
  await selectRange(page, 0, 5);
  await editor(page).press('Control+a');
  await expectSelected(page, source);
  await paste(page, source);
  await expect(editor(page)).toHaveValue(source);
  expect(await editor(page).evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart, end: element.selectionEnd,
  }))).toEqual({ start: source.length, end: source.length });
  await expectSelected(page, source);
  await expect(run(page)).toBeEnabled();
  expect(requests.corrections).toHaveLength(0);
  await startCorrection(page);
  await expect(cards(page)).toHaveCount(3);
  expect(requests.corrections.map(input => input.sourceText)).toEqual([source]);
});

test('same selected clipboard paste retains reasons and applies only the second repeated occurrence', async ({ page }) => {
  const requests = await mockModels(page);
  const target = '금요일까지 자료를 보내 주세요.';
  const source = `앞😀 ${target}\n중간. ${target}\n끝😀`;
  const start = source.lastIndexOf(target);
  await page.goto('/');
  await editor(page).fill(source);
  await selectRange(page, start, start + target.length);
  await startCorrection(page);
  await expect(cards(page)).toHaveCount(3);
  await cards(page).first().locator('summary').click();
  await page.getByRole('button', { name: '교정 이유', exact: true }).click();
  await expect(page.locator('.candidate-explanation')).toHaveCount(3);
  await expect(page.locator('.candidate-explanation').first()).toContainText(explanation);
  await selectRange(page, start, start + target.length);
  await paste(page, target);
  await expect(editor(page)).toHaveValue(source);
  await expectSelected(page, target);
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).first().locator('details')).toHaveAttribute('open', '');
  await expect(page.locator('.candidate-explanation')).toHaveCount(3);
  expect(requests.corrections.map(input => input.sourceText)).toEqual([target]);
  expect(requests.explanations).toHaveLength(1);
  await cards(page).first().getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(editor(page)).toHaveValue(source.slice(0, start) + `${target} (대안 1)` + source.slice(start + target.length));
  await expect(cards(page).first().getByRole('button', { name: '적용됨', exact: true })).toBeDisabled();
  expect(requests.corrections).toHaveLength(1);
});

test('same clipboard paste while correction is pending keeps its valid request and replacement range', async ({ page }) => {
  const response = gate();
  const requested = gate();
  const requests = await mockModels(page, async () => { requested.resolve(); await response.promise; });
  const target = '보내 주세요.';
  const source = `앞 ${target} 중간 ${target} 끝`;
  const start = source.lastIndexOf(target);
  await page.goto('/');
  await editor(page).fill(source);
  await selectRange(page, start, start + target.length);
  try {
    await startCorrection(page);
    await requested.promise;
    await selectRange(page, start, start + target.length);
    await paste(page, target);
    await expect(editor(page)).toHaveValue(source);
    await expectSelected(page, target);
    await expect(page.locator('.correction-fallback')).toBeDisabled();
    expect(requests.corrections).toHaveLength(1);
    response.resolve();
    await expect(cards(page)).toHaveCount(3);
    await cards(page).first().getByRole('button', { name: '이 문장 적용', exact: true }).click();
    await expect(editor(page)).toHaveValue(source.slice(0, start) + `${target} (대안 1)` + source.slice(start + target.length));
  } finally {
    response.resolve();
  }
});

test('different clipboard paste invalidates candidates and reasons until a fresh selection is made', async ({ page }) => {
  const requests = await mockModels(page);
  const source = '기존 원문입니다.';
  const replacement = '새로운 원문😀입니다.\n다음 문장입니다.';
  await page.goto('/');
  await editor(page).fill(source);
  await selectRange(page, 0, source.length);
  await startCorrection(page);
  await expect(cards(page)).toHaveCount(3);
  await page.getByRole('button', { name: '교정 이유', exact: true }).click();
  await expect(page.locator('.candidate-explanation').first()).toContainText(explanation);
  await selectRange(page, 0, source.length);
  await paste(page, replacement);
  await expect(editor(page)).toHaveValue(replacement);
  await expectSelected(page, '아직 선택한 문장이 없습니다.');
  await expect(run(page)).toBeDisabled();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator('.candidate-explanation')).toHaveCount(0);
  expect(requests.corrections).toHaveLength(1);
  await selectRange(page, 0, replacement.length);
  await startCorrection(page);
  await expect(cards(page)).toHaveCount(3);
  expect(requests.corrections.map(input => input.sourceText)).toEqual([source, replacement]);
});

test('different clipboard paste during a pending request rejects its late response and accepts a fresh request', async ({ page }) => {
  const response = gate();
  const requested = gate();
  const requests = await mockModels(page, async (_input, index) => {
    if (index === 0) { requested.resolve(); await response.promise; }
  });
  const source = '기존 원문입니다.';
  const replacement = '새 원문입니다.';
  await page.goto('/');
  await editor(page).fill(source);
  await selectRange(page, 0, source.length);
  try {
    await startCorrection(page);
    await requested.promise;
    await selectRange(page, 0, source.length);
    await paste(page, replacement);
    await expect(editor(page)).toHaveValue(replacement);
    await expectSelected(page, '아직 선택한 문장이 없습니다.');
    await expect(run(page)).toBeDisabled();
    response.resolve();
    await expect(cards(page)).toHaveCount(0);
    await selectRange(page, 0, replacement.length);
    await startCorrection(page);
    await expect(cards(page)).toHaveCount(3);
    await expect(cards(page).first().locator('.candidate-text')).toHaveText(`${replacement} (대안 1)`);
    expect(requests.corrections.map(input => input.sourceText)).toEqual([source, replacement]);
    expect(requests.corrections[0].requestId).not.toBe(requests.corrections[1].requestId);
    await cards(page).first().getByRole('button', { name: '이 문장 적용', exact: true }).click();
    await expect(editor(page)).toHaveValue(`${replacement} (대안 1)`);
  } finally {
    response.resolve();
  }
});
