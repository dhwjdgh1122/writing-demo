import { test, expect } from '@playwright/test';
import { expectSelected, startCorrection } from './selection-helpers';

for (const width of [1440, 390]) {
  test(`compact selection and existing results survive direct execution/failure/retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const target = '안녕 하세요. 다음주 목요일 오후 3시에 팀 회의를 진행할 예정 입니다.\n참석 가능하신 분들은 수요일 까지 댓글로 알려 주시기바랍니다.\n회의 자료는 미리 읽어보시고, 궁금한점은 따로 적어 주세요.\n참석이 어려우신 분들에게는 회의가 끝난뒤 내용을 공유 하겠습니다.';
    const corrected = target.replace('안녕 하세요', '안녕하세요');
    const prefix = '앞 문장은 유지합니다.\n';
    const suffix = '\n뒤 문장도 유지합니다.';
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON();
      expect(input.sourceText).toBe(target);
      calls++;
      if (calls === 1) {
        await gate;
        await route.fulfill({ status: 503, json: { requestId: input.requestId, error: {
          code: 'MODEL_UNAVAILABLE', message: '테스트용 일시 오류입니다. 다시 시도해주세요.', retryable: true,
        } } });
      } else {
        await route.fulfill({ json: { ...input, candidates: [
          { id: 'layout-1', text: corrected },
          { id: 'layout-2', text: target.replace('다음주', '다음 주') },
          { id: 'layout-same', text: target },
        ] } });
      }
    });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    const run = page.getByRole('button', { name: '교정 실행', exact: true });
    await expect(run).toBeDisabled();
    const editorPanel = await page.getByRole('region', { name: '원문 작업 공간' }).boundingBox();
    const selectionPanel = await page.locator('.compact-selection').boundingBox();
    const resultsPanel = await page.getByRole('region', { name: '교정 패널' }).boundingBox();
    expect(selectionPanel!.y).toBeGreaterThan(editorPanel!.y);
    expect(selectionPanel!.y + selectionPanel!.height).toBeLessThan(editorPanel!.y + editorPanel!.height);
    await expect(page.locator('.selection-panel')).toHaveCount(0);
    if (width >= 1024) {
      expect(resultsPanel!.x).toBeGreaterThanOrEqual(editorPanel!.x + editorPanel!.width);
      expect(resultsPanel!.y).toBeCloseTo(editorPanel!.y, 0);
    } else {
      expect(resultsPanel!.y).toBeGreaterThanOrEqual(editorPanel!.y + editorPanel!.height);
    }
    await editor.fill(prefix + target + suffix);
    await editor.evaluate((el: HTMLTextAreaElement, range) => {
      el.focus(); el.setSelectionRange(range[0], range[1]);
    }, [prefix.length, prefix.length + target.length]);
    await page.keyboard.press('Shift');
    await editor.press('Shift+Tab');
    await expect(run).toBeFocused();
    await expectSelected(page, target);
    await startCorrection(page);
    await expect(page.getByRole('button', { name: '교정 중' })).toBeDisabled();
    await expect(page.locator('.results-section')).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(page.locator('.error-message')).toContainText('다시 시도');
    await expect(run).toBeEnabled();
    await expect(editor).toHaveValue(prefix + target + suffix);
    await startCorrection(page);
    await expect(page.locator('.candidate-card')).toHaveCount(3);
    await expect(page.getByRole('button', { name: '변경 없음' })).toBeDisabled();
    const first = page.locator('.candidate-card').first();
    await expect(first.locator('details')).not.toHaveAttribute('open', '');
    await page.screenshot({ path: `test-results/selection-layout-${width}.png`, fullPage: true });
    await first.locator('summary').click();
    await expect(first.locator('.comparison-content')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/selection-layout-comparison-${width}.png`, fullPage: true });
    await first.locator('summary').click();
    await expect(first.locator('.comparison-content')).not.toBeVisible();
    await first.getByRole('button', { name: '이 문장 적용', exact: true }).click();
    await expect(editor).toHaveValue(prefix + corrected + suffix);
    await expect(run).toBeFocused();
    await expectSelected(page, corrected);
    await expect(page.locator('.candidate-card')).toHaveCount(0);
    expect(calls).toBe(2);
  });
}
