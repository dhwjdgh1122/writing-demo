import { expect, test, type Page } from '@playwright/test';
import type { CorrectionInput, ExplanationInput } from '../../shared/contracts';
import { startCorrection } from './selection-helpers';

const source = '안녕 하세요. 다음주 목요일 오후 3시에 팀 회의를 진행할 예정 입니다.\n'
  + '참석 가능하신 분들은 수요일 까지 댓글로 알려 주시기바랍니다.\n'
  + '회의 자료는 미리 읽어보시고, 궁금한점은 따로 적어 주세요.\n'
  + '참석이 어려우신 분들에게는 회의가 끝난뒤 내용을 공유 하겠습니다.';
const corrected = source.replace('안녕 하세요', '안녕하세요').replace('다음주', '다음 주')
  .replace('예정 입니다', '예정입니다').replace('수요일 까지', '수요일까지')
  .replace('주시기바랍니다', '주시기 바랍니다').replace('궁금한점', '궁금한 점');
const editor = (page: Page) => page.getByLabel('원문 입력');
const panel = (page: Page) => page.getByRole('region', { name: '원문 작업 공간', exact: true });
const cards = (page: Page) => page.locator('.correction-view .candidate-card');

async function prepare(page: Page, prefix = '') {
  await page.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON() as CorrectionInput;
    await route.fulfill({ json: { ...input, candidates: [
      { id: 'sticky-first', text: corrected },
      { id: 'sticky-second', text: corrected.replace('알려', '남겨') },
      { id: 'sticky-third', text: corrected.replace('따로', '별도로') },
    ] } });
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    await route.fulfill({ json: { ...input, explanations: input.candidates.map(candidate => ({
      candidateId: candidate.id,
      explanation: '변경된 띄어쓰기와 요청 표현을 원문과 비교해 확인할 수 있습니다. '.repeat(6).trim(),
    })) } });
  });
  await page.goto('/');
  await editor(page).fill(prefix + source);
  await editor(page).evaluate((element: HTMLTextAreaElement, start) => {
    element.focus();
    element.setSelectionRange(start, element.value.length);
  }, prefix.length);
  await page.keyboard.press('Shift');
  await startCorrection(page);
  await expect(cards(page)).toHaveCount(3);
  await page.getByRole('button', { name: '교정 이유', exact: true }).click();
  await expect(cards(page).locator('.candidate-explanation > p')).toHaveCount(3);
  for (let index = 0; index < 3; index++) await cards(page).nth(index).locator('summary').click();
}

async function expectPanelVisible(page: Page) {
  await expect.poll(async () => panel(page).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const textarea = element.querySelector('textarea')!;
    const inputBounds = textarea.getBoundingClientRect();
    const controls = element.querySelector('.editor-controls')!.getBoundingClientRect();
    const footnote = element.querySelector('.editor-footnote')!.getBoundingClientRect();
    const hit = document.elementFromPoint(inputBounds.left + inputBounds.width / 2, inputBounds.top + 2);
    return bounds.top >= 15 && bounds.bottom <= window.innerHeight - 15
      && inputBounds.height > 80 && inputBounds.top >= controls.bottom
      && inputBounds.bottom <= footnote.top && hit === textarea;
  })).toBe(true);
}

test('the full source panel stays readable while expanded comparisons and reasons scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  await prepare(page);
  // Use page scrolling, not focus/scrollIntoView on the source panel, so the
  // assertion proves that reading lower candidates itself retains the source.
  await page.evaluate(() => window.scrollTo(0, 700));
  await expectPanelVisible(page);
  const firstTop = (await cards(page).first().boundingBox())!.y;
  const sourceTop = (await panel(page).boundingBox())!.y;
  await page.evaluate(() => window.scrollBy(0, 350));
  await expectPanelVisible(page);
  expect((await panel(page).boundingBox())!.y).toBeCloseTo(sourceTop, 0);
  expect((await cards(page).first().boundingBox())!.y).toBeLessThan(firstTop - 300);
  await expect(editor(page)).toHaveValue(source);
  await expect(page.getByRole('button', { name: '교정 실행', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/sticky-source-desktop.png' });
});

test('applying a lower candidate reveals the original range without jumping the page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  const prefix = '그대로 유지할 앞쪽 문장입니다.\n'.repeat(60);
  await prepare(page, prefix);
  const apply = cards(page).nth(1).getByRole('button', { name: '이 문장 적용', exact: true });
  await apply.scrollIntoViewIfNeeded();
  await expectPanelVisible(page);
  await editor(page).evaluate((element: HTMLTextAreaElement) => { element.scrollTop = 0; });
  const buttonTop = (await apply.boundingBox())!.y;
  const sourceTop = (await panel(page).boundingBox())!.y;
  await apply.click();
  const replacement = corrected.replace('알려', '남겨');
  await expect(editor(page)).toHaveValue(prefix + replacement);
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveClass('applied-highlight');
  await expect.poll(async () => editor(page).evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart, end: element.selectionEnd,
    internallyScrolled: element.scrollTop > 0,
  }))).toEqual({ start: prefix.length, end: prefix.length + replacement.length, internallyScrolled: true });
  // Applying adds status/help above this card. Native scroll anchoring can
  // change scrollY to keep the visible content still; measure screen positions.
  const applied = cards(page).nth(1).getByRole('button', { name: '적용됨', exact: true });
  await expect.poll(async () => Math.abs((await applied.boundingBox())!.y - buttonTop)).toBeLessThan(2);
  expect((await panel(page).boundingBox())!.y).toBeCloseTo(sourceTop, 0);
  await expectPanelVisible(page);
  await expect(page.locator('.floating-correction')).toHaveCount(0);
});

test('narrow or short viewports release the panel and a sufficient viewport restores it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  await prepare(page);
  for (const viewport of [{ width: 1023, height: 820 }, { width: 1440, height: 599 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 700));
    await expect.poll(async () => (await panel(page).boundingBox())!.y).toBeLessThan(0);
    expect(await panel(page).evaluate(element => getComputedStyle(element).position)).not.toBe('sticky');
    await expect(editor(page)).toHaveValue(source);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.setViewportSize({ width: 1024, height: 600 });
    await page.evaluate(() => window.scrollTo(0, 700));
    await expectPanelVisible(page);
  }
  await page.setViewportSize({ width: 390, height: 640 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const inputBounds = (await panel(page).boundingBox())!;
  const resultBounds = (await page.getByRole('region', { name: '교정 패널', exact: true }).boundingBox())!;
  expect(resultBounds.y).toBeGreaterThanOrEqual(inputBounds.y + inputBounds.height);
});

test('long originals scroll inside a viewport-sized panel without moving its controls or the page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  await prepare(page, '그대로 유지할 긴 원문입니다.\n'.repeat(100));
  await page.evaluate(() => window.scrollTo(0, 700));
  await expectPanelVisible(page);
  await editor(page).evaluate((element: HTMLTextAreaElement) => { element.scrollTop = 0; });
  const bounds = (await editor(page).boundingBox())!;
  const controlsTop = (await page.locator('.editor-controls').boundingBox())!.y;
  const pageTop = await page.evaluate(() => window.scrollY);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => editor(page).evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBeGreaterThan(100);
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(pageTop, 0);
  expect((await page.locator('.editor-controls').boundingBox())!.y).toBeCloseTo(controlsTop, 0);
  expect(await editor(page).evaluate(element => getComputedStyle(element).resize)).toBe('none');

  const regularHeight = (await panel(page).boundingBox())!.height;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 700));
  await expectPanelVisible(page);
  const tallHeight = (await panel(page).boundingBox())!.height;
  expect(tallHeight).toBeGreaterThan(regularHeight);
  expect(tallHeight).toBeLessThanOrEqual(901);
});
