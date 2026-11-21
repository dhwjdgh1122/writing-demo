import { startCorrection } from './selection-helpers';
import { test, expect } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`plain candidate and expression comparison preserve exact scoped application at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const source = '안녕 하세요.\t목요일에 안내합니다.\n기호 · ↵ ⇥는 그대로 둡니다.';
    const candidate = '안녕하세요.\t금요일에 안내합니다. 기호 · ↵ ⇥는 그대로 둡니다.';
    const prefix = '앞 문장은 그대로입니다.\n';
    const suffix = '\n뒤 문장도 그대로입니다.';
    let explanationRequests = 0;
    let correctionRequests = 0;
    await page.route('**/api/explanations', async route => { explanationRequests++; await route.abort(); });
    await page.route('**/api/corrections', async route => {
      correctionRequests++;
      const input = route.request().postDataJSON();
      expect(input.sourceText).toBe(source);
      await route.fulfill({ json: { ...input, candidates: [{ id: 'legend-fixture', text: candidate }] } });
    });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    await editor.fill(prefix + source + suffix);
    await editor.evaluate((el: HTMLTextAreaElement, range) => {
      el.focus(); el.setSelectionRange(range[0], range[1]);
    }, [prefix.length, prefix.length + source.length]);
    await page.keyboard.press('Shift');
    await startCorrection(page);
    const card = page.locator('.candidate-card');
    await expect(card).toBeVisible();
    expect(await card.locator('.candidate-text').textContent()).toBe(candidate);
    await expect(card.locator('.candidate-text ins, .candidate-text del')).toHaveCount(0);
    await expect(card.locator('.deletion-note')).toHaveCount(0);
    // Open with the keyboard; showing the legend must not apply a candidate or request AI explanations.
    const summary = card.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    const legend = card.getByRole('group', { name: '변경 표시 안내' });
    await expect(legend).toBeVisible();
    await expect(legend.getByRole('listitem')).toHaveText(['원문의 변경 표현', '교정안의 변경 표현']);
    const sourceView = card.locator('.comparison-content > p').first();
    const candidateView = card.locator('.comparison-content > p').last();
    // Whole paragraphs remain in reading order, including unchanged tabs and literal · ↵ ⇥.
    expect(await sourceView.textContent()).toBe(source);
    expect(await candidateView.textContent()).toBe(candidate);
    await expect(card.locator('.diff-whitespace')).toHaveCount(0);
    expect((await sourceView.locator('del').allTextContents()).join('')).toContain('안녕 하세요.');
    expect((await candidateView.locator('ins').allTextContents()).join('')).toContain('안녕하세요.');
    expect((await sourceView.locator('del').allTextContents()).join('')).toContain('목요일에');
    expect((await candidateView.locator('ins').allTextContents()).join('')).toContain('금요일에');
    expect((await candidateView.locator('ins').allTextContents()).join('')).not.toContain('그대로 둡니다.');
    await expect(editor).toHaveValue(prefix + source + suffix);
    expect(explanationRequests).toBe(0);
    expect(correctionRequests).toBe(1);
    await summary.focus();
    await page.keyboard.press('Space');
    await expect(legend).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(legend).toBeVisible();
    expect(correctionRequests).toBe(1);
    expect(explanationRequests).toBe(0);
    const summaryBounds = await summary.boundingBox();
    expect(summaryBounds!.height).toBeGreaterThanOrEqual(44);
    expect(await sourceView.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(15);
    const bounds = await legend.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const item of await legend.getByRole('listitem').all()) {
      const box = await item.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
    await card.screenshot({ path: `test-results/comparison-legend-${width}.png` });
    await page.getByRole('button', { name: '이 문장 적용', exact: true }).click();
    // The unchanged tab and literal symbols survive; generated whitespace markers never enter the document.
    await expect(editor).toHaveValue(prefix + candidate + suffix);
    await expect(card).toHaveCount(0);
  });
}

test('expression comparison preserves literal whitespace and symbols on copy and application', async ({ page }) => {
  const source = '첫째\t항목 끝\n기호 · ↵ ⇥는 그대로 둡니다.';
  const candidate = '첫째 항목\t끝\n새 줄 추가\n기호 · ↵ ⇥는 그대로 둡니다.';
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'mixed-whitespace', text: candidate }] } });
  });
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  await editor.fill(source);
  await editor.evaluate((el: HTMLTextAreaElement) => {
    el.focus(); el.setSelectionRange(0, el.value.length);
  });
  await page.keyboard.press('Shift');
  await startCorrection(page);
  const card = page.locator('.candidate-card');
  await card.locator('summary').click();
  const paragraphs = card.locator('.comparison-content > p');
  const sourceView = paragraphs.nth(0);
  const candidateView = paragraphs.nth(1);
  expect(await sourceView.textContent()).toBe(source);
  expect(await candidateView.textContent()).toBe(candidate);
  // A copied comparison must not contain generated symbols or duplicate changed line breaks.
  for (const [view, expected] of [[sourceView, source], [candidateView, candidate]] as const) {
    const copied = await view.evaluate(el => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      const value = selection.toString();
      selection.removeAllRanges();
      return value;
    });
    expect(copied).toBe(expected);
  }
  await expect(paragraphs.getByRole('img')).toHaveCount(0);
  expect((await sourceView.locator('del').allTextContents()).join('')).toContain('첫째\t항목 끝');
  expect((await candidateView.locator('ins').allTextContents()).join('')).toContain('첫째 항목\t끝');
  expect((await candidateView.locator('ins').allTextContents()).join('')).toContain('새 줄 추가');
  await card.getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(editor).toHaveValue(candidate);
});
