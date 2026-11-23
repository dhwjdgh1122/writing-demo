import { expect, type Page } from '@playwright/test';

export async function startCorrection(page: Page) {
  await page.getByRole('button', { name: '교정 실행', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function expectSelected(page: Page, text: string) {
  if (text === '아직 선택한 문장이 없습니다.') {
    await expect(page.locator('.compact-selection')).toContainText('교정할 문장을 선택해주세요.');
    return;
  }
  await expect(page.locator('.compact-selection')).toContainText(`선택한 글 ${Array.from(text).length.toLocaleString()}자`);
  const range = await page.getByLabel('원문 입력').evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart, end: element.selectionEnd,
    text: element.value.slice(element.selectionStart, element.selectionEnd),
  }));
  // A caret move intentionally retains the prior correction selection. Its exact
  // source is checked by request-body assertions in the selection-scope test.
  if (range.start !== range.end) expect(range.text).toBe(text);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
