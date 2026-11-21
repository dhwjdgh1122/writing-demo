import { test, expect } from '@playwright/test';

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`long readonly preview scrolls without hiding actions at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const text = Array.from({ length: 35 }, (_, i) => `${i + 1}. 날짜와  공백\t😀를 유지합니다.`).join('\n');
    let calls = 0;
    await page.route('**/api/corrections', async route => {
      calls++;
      const input = route.request().postDataJSON();
      expect(input.sourceText).toBe(text);
      await route.fulfill({ json: { ...input, candidates: [{ id: 'preview', text: text + ' 끝' }] } });
    });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    await editor.fill(text);
    await editor.press('Control+Home');
    await editor.press('Control+Shift+End');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const run = page.getByRole('button', { name: '교정 실행', exact: true });
    await run.focus();
    await run.scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const editorScroll = await editor.evaluate(el => el.scrollTop);
    await run.press('Enter');
    const dialog = page.getByRole('dialog');
    const preview = dialog.getByRole('region', { name: '선택한 문장' });
    await expect(dialog).toBeVisible();
    expect(await preview.textContent()).toBe(text);
    expect(await preview.evaluate(el => el instanceof HTMLElement && el.isContentEditable)).toBe(false);
    await expect(dialog.locator('textarea,input')).toHaveCount(0);
    expect(await preview.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const confirm = dialog.getByRole('button', { name: '교정 시작' });
    const before = await confirm.boundingBox();
    await preview.focus();
    await preview.press('Control+End');
    await expect.poll(() => preview.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect((await confirm.boundingBox())!.y).toBeCloseTo(before!.y, 0);
    const bounds = await dialog.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
    await confirm.focus();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(await editor.evaluate(el => el.scrollTop)).toBe(editorScroll);
    expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, text.length]);
    expect(calls).toBe(0);
    await run.click();
    await page.screenshot({ path: `test-results/selection-confirm-${size.width}.png` });
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.selection-highlight')).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(page.locator('.candidate-card')).toHaveCount(1);
    await expect(editor).toHaveValue(text);
    expect(calls).toBe(1);
  });
}

test('floating action does not interrupt drag or copy; cancel and replace range before confirming', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  const source = '첫 번째 줄입니다.\n두 번째 줄입니다.\n세 번째 줄입니다.\n네 번째 줄입니다.';
  await editor.fill(source);
  const box = (await editor.boundingBox())!;
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.mouse.move(box.x + 18, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 30, { steps: 10 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.floating-correction')).toHaveCount(0);
  await page.mouse.up();
  const floating = page.getByRole('button', { name: '교정하기', exact: true });
  await expect(floating).toBeVisible();
  const floatingBox = (await floating.boundingBox())!;
  expect(floatingBox.y).toBeLessThan(box.y + 100);
  expect(floatingBox.x).toBeGreaterThanOrEqual(box.x);
  expect(floatingBox.x + floatingBox.width).toBeLessThanOrEqual(box.x + box.width);
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
  await editor.press('Control+c');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const first = await editor.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  await floating.click();
  await expect(page.getByTestId('selected-text')).toHaveText(first);
  await page.getByRole('button', { name: '원문으로 돌아가기' }).click();
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await editor.press('Shift+Home');
  await expect(floating).toBeVisible();
  await floating.click();
  await expect(page.getByTestId('selected-text')).toHaveText('네 번째 줄입니다.');
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(editor).toHaveValue(source);
  await page.getByRole('button', { name: '선택 해제' }).click();
  await expect(floating).toHaveCount(0);
  await expect(page.getByRole('button', { name: '교정 실행', exact: true })).toBeDisabled();
});

for (const direction of ['forward', 'backward'] as const) {
  test(`floating action captures a ${direction} drag released outside the editor`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const requests: string[] = [];
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON();
      requests.push(input.sourceText);
      await route.fulfill({ json: { ...input, candidates: [{ id: 'outside-drag', text: input.sourceText + ' 수정' }] } });
    });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    const source = '첫 번째 줄입니다.\n두 번째 줄입니다.\n세 번째 줄입니다.';
    await editor.fill(source);
    const box = (await editor.boundingBox())!;
    const y = box.y + 30;
    const start = direction === 'forward' ? { x: box.x + 18, y } : { x: box.x + 140, y: y + 32 };
    const end = direction === 'forward' ? { x: box.x + box.width + 12, y: y + 32 } : { x: box.x - 12, y };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await expect(page.locator('.floating-correction')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.mouse.up();
    const selected = await editor.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selected.length).toBeGreaterThan(0);
    const floating = page.getByRole('button', { name: '교정하기', exact: true });
    await expect(floating).toBeVisible();
    expect(requests).toHaveLength(0);
    await floating.click();
    expect(await page.getByTestId('selected-text').textContent()).toBe(selected);
    await page.getByRole('button', { name: '교정 시작', exact: true }).click();
    await expect(page.locator('.candidate-card')).toHaveCount(1);
    expect(requests).toEqual([selected]);
    await expect(editor).toHaveValue(source);
  });
}

for (const interruption of ['pointercancel', 'blur'] as const) {
  test(`interrupted drag ignores other pointers and allows keyboard selection after ${interruption}`, async ({ page }) => {
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    const source = '포인터 취소 뒤에도 키보드 선택이 동작합니다.';
    await editor.fill(source);
    // Inject lifecycle interruptions that normal Playwright mouse movement does not emit.
    await editor.dispatchEvent('pointerdown', { pointerId: 41, isPrimary: true, button: 0 });
    await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, el.value.length));
    await page.keyboard.press('Shift');
    await expect(page.locator('.floating-correction')).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 42 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 42 }));
    });
    await page.keyboard.press('Shift');
    await expect(page.locator('.floating-correction')).toHaveCount(0);
    await page.evaluate(type => {
      window.dispatchEvent(type === 'blur' ? new Event('blur') : new PointerEvent('pointercancel', { pointerId: 41 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 41 }));
    }, interruption);
    await expect(page.locator('.floating-correction')).toHaveCount(0);
    await page.keyboard.press('Shift');
    const floating = page.getByRole('button', { name: '교정하기', exact: true });
    await expect(floating).toBeVisible();
    await floating.click();
    expect(await page.getByTestId('selected-text').textContent()).toBe(source);
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(source);
  });
}

test('preview snapshot cannot submit after source changes', async ({ page }) => {
  let calls = 0;
  page.on('request', req => { if (req.url().endsWith('/api/corrections')) calls++; });
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  await editor.fill('처음 문장');
  await editor.press('Control+a');
  await page.getByRole('button', { name: '교정 실행', exact: true }).click();
  // Simulate a non-pointer edit while the modal owns focus; background user input is inert.
  await editor.evaluate((el: HTMLTextAreaElement) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, '바뀐 원문');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: '교정 시작', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(editor).toHaveValue('바뀐 원문');
  await expect(page.locator('.selection-highlight')).toHaveCount(0);
  expect(calls).toBe(0);
});
