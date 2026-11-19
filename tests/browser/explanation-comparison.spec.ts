import { test, expect } from '@playwright/test';
import { startCorrection } from './selection-helpers';

for (const width of [1440, 390]) {
  test(`explanation comparison guidance preserves candidate scope and retry flow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const source = '승인되면 목요일에 15명에게 안내합니다.\n' + '추가 안내는 담당자가 전달합니다. '.repeat(18);
    const candidates = [
      { id: 'first', text: source.replace('목요일', '금요일') },
      { id: 'second', text: source.replace('15명', '20명') },
      { id: 'third', text: source.replace('안내합니다', '알려드립니다') },
    ];
    let corrections = 0;
    const requests: string[][] = [];
    await page.route('**/api/corrections', async route => {
      corrections++;
      await route.fulfill({ json: { ...route.request().postDataJSON(), candidates } });
    });
    await page.route('**/api/explanations', async route => {
      const input = route.request().postDataJSON();
      requests.push(input.candidates.map((c: { id: string }) => c.id));
      await route.fulfill({ json: { ...input, explanations: input.candidates.map((c: { id: string }) =>
        c.id === 'third' && requests.length === 1
          ? { candidateId: c.id, error: 'EXPLANATION_QUOTE_MISMATCH' }
          : { candidateId: c.id, explanation: `${c.id} 후보의 테스트용 설명입니다.` }) } });
    });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    await editor.fill(source);
    await editor.press('Control+a');
    await startCorrection(page);
    const cards = page.locator('.candidate-card');
    const toggle = page.getByRole('button', { name: /교정 이유/ });
    const compare = page.getByRole('button', { name: '원문 비교 확인' });
    await expect(cards).toHaveCount(3);
    await expect(compare).toHaveCount(0);
    await toggle.click();
    await expect(compare).toHaveCount(2);
    await expect(page.locator('details.comparison[open]')).toHaveCount(0);
    await expect(cards.nth(2)).toContainText('이 후보의 설명을 표시하지 않았습니다');
    await expect(cards.first().locator('.explanation-comparison-help')).toContainText('날짜·수치·조건');
    await expect(page.locator('.explanation-status')).not.toContainText('실제 차이와 함께 확인해주세요');

    const secondCompare = cards.nth(1).getByRole('button', { name: '원문 비교 확인' });
    await expect(secondCompare).toHaveAttribute('aria-controls', (await cards.nth(1).locator('details').getAttribute('id'))!);
    await secondCompare.focus();
    await page.keyboard.press('Enter');
    await expect(cards.nth(1).locator('details')).toHaveAttribute('open', '');
    await expect(cards.nth(1).locator('summary')).toBeFocused();
    await expect(page.locator('details.comparison[open]')).toHaveCount(1);
    await expect(editor).toHaveValue(source);
    expect(requests).toEqual([['first', 'second', 'third']]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await cards.nth(1).locator('.candidate-explanation').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/explanation-comparison-${width}.png` });

    // Native summary still closes; the helper always opens rather than toggles.
    await cards.nth(1).locator('summary').press('Enter');
    await expect(page.locator('details.comparison[open]')).toHaveCount(0);
    await secondCompare.click();
    await secondCompare.click();
    await expect(page.locator('details.comparison[open]')).toHaveCount(1);
    await toggle.click();
    await expect(compare).toHaveCount(0);
    await toggle.click();
    await expect(compare).toHaveCount(2);
    expect(requests).toHaveLength(1);
    await page.getByRole('button', { name: '실패한 설명 다시 시도' }).click();
    await expect(compare).toHaveCount(3);
    await expect(cards.first()).toContainText('first 후보의 테스트용 설명');
    expect(requests).toEqual([['first', 'second', 'third'], ['third']]);
    expect(corrections).toBe(1);
    // Applying a candidate does not require opening its comparison.
    await expect(cards.first().locator('details')).not.toHaveAttribute('open', '');
    await cards.first().getByRole('button', { name: '이 문장 적용', exact: true }).click();
    await expect(editor).toHaveValue(candidates[0].text);
    await expect(compare).toHaveCount(0);
    await expect(cards).toHaveCount(0);
  });
}
