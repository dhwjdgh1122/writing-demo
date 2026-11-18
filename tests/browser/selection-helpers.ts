import { expect, type Page } from '@playwright/test';

export async function startCorrection(page: Page) {
  await page.getByRole('button', { name: '교정 실행', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '교정 시작', exact: true }).click();
}

export async function expectSelected(page: Page, text: string) {
  if (text === '아직 선택한 문장이 없습니다.') {
    await expect(page.locator('.compact-selection')).toContainText('교정할 문장을 선택해주세요.');
    return;
  }
  await page.getByRole('button', { name: '교정 실행', exact: true }).click();
  await expect(page.getByTestId('selected-text')).toHaveText(text);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
