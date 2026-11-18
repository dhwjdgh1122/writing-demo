import { test, expect } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`background selection survives modal focus, scrolling and resize at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    const prefix = '선택하지 않은 앞 문장입니다.\n'.repeat(40);
    const target = '목요일  오후 3시 😀에 회의합니다.\n참석 가능한 분들은\t수요일까지 알려주세요.\n자료를 확인해주세요.';
    const source = prefix + target + '\n선택하지 않은 뒤 문장입니다.';
    await editor.fill(source);
    await editor.press('Control+End');
    await editor.evaluate((el: HTMLTextAreaElement, range) => el.setSelectionRange(range[0], range[1]), [prefix.length, prefix.length + target.length]);
    await editor.press('Shift');
    await page.getByRole('button', { name: '교정 실행', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const mirror = page.locator('.selection-highlight');
    await expect(mirror).toHaveAttribute('aria-hidden', 'true');
    expect(await mirror.locator('mark').textContent()).toBe(target);
    expect(await page.getByTestId('selected-text').textContent()).toBe(target);
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    const aligned = async () => {
      const actual = await editor.evaluate(el => ({ x: el.getBoundingClientRect().x + el.clientLeft, y: el.getBoundingClientRect().y + el.clientTop, width: el.clientWidth, height: el.clientHeight, scroll: el.scrollTop }));
      const drawn = await mirror.boundingBox();
      expect(drawn!.x).toBeCloseTo(actual.x, 0);
      expect(drawn!.y).toBeCloseTo(actual.y, 0);
      expect(drawn!.width).toBeCloseTo(actual.width, 0);
      expect(drawn!.height).toBeCloseTo(actual.height, 0);
      expect(await mirror.evaluate(el => el.scrollTop)).toBe(actual.scroll);
      expect(await editor.inputValue()).toBe(source);
    };
    await aligned();
    await page.screenshot({ path: `test-results/selection-highlight-${width}.png`, fullPage: true });
    await page.setViewportSize({ width: width === 1440 ? 1000 : 430, height: 850 });
    await expect.poll(() => mirror.evaluate(el => el.clientWidth)).toBe(await editor.evaluate(el => el.clientWidth));
    await aligned();
    await page.keyboard.press('Escape');
    await expect(mirror).toHaveCount(0);
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([prefix.length, prefix.length + target.length]);
  });
}
