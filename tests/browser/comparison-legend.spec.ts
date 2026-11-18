import { test, expect } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`comparison legend preserves whitespace and literal symbols on apply at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const source = '안녕 하세요.\t목요일에 안내합니다.\n기호 · ↵ ⇥는 그대로 둡니다.';
    const candidate = '안녕하세요.\t금요일에 안내합니다. 기호 · ↵ ⇥는 그대로 둡니다.';
    const prefix = '앞 문장은 그대로입니다.\n';
    const suffix = '\n뒤 문장도 그대로입니다.';
    let explanationRequests = 0;
    await page.route('**/api/explanations', async route => { explanationRequests++; await route.abort(); });
    await page.route('**/api/corrections', async route => {
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
    await page.getByRole('button', { name: '교정 실행' }).click();
    const card = page.locator('.candidate-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.candidate-text')).toHaveText(candidate);
    // Open with the keyboard; showing the legend must not apply a candidate or request AI explanations.
    const summary = card.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    const legend = card.getByRole('group', { name: '변경 표시 안내' });
    await expect(legend).toBeVisible();
    await expect(legend.getByRole('listitem')).toHaveText(['추가밑줄', '삭제취소선', '·공백', '↵줄바꿈', '⇥탭']);
    const sourceView = card.locator('.comparison-content > p').first();
    const candidateView = card.locator('.comparison-content > p').last();
    await expect(sourceView).toContainText('⇥목요일에·안내합니다.↵');
    await expect(candidateView).toContainText('⇥금요일에·안내합니다.·기호');
    expect(await sourceView.locator('del').allTextContents()).toContain('↵\n');
    expect((await candidateView.locator('ins').allTextContents()).join('')).toContain('금');
    await expect(editor).toHaveValue(prefix + source + suffix);
    expect(explanationRequests).toBe(0);
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
    // Real tab and literal symbols must survive; display-only middle dots and arrows must not leak into the text.
    await expect(editor).toHaveValue(prefix + candidate + suffix);
    await expect(card).toHaveCount(0);
  });
}
