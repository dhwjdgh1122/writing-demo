import { test, expect } from '@playwright/test';

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`keyboard execution immediately submits the exact long selection at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const text = Array.from({ length: 35 }, (_, i) => `${i + 1}. 날짜와  공백\t😀를 유지합니다.`).join('\n');
    const requests: string[] = [];
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON();
      requests.push(input.sourceText);
      await route.fulfill({ json: { ...input, candidates: [{ id: 'direct', text: text + ' 끝' }] } });
    });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    await editor.fill(text);
    await editor.press('Control+Home');
    await editor.press('Control+Shift+End');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(requests).toHaveLength(0);
    const run = page.getByRole('button', { name: '교정 실행', exact: true });
    await run.focus();
    await run.scrollIntoViewIfNeeded();
    await run.press('Enter');
    await expect(page.locator('.candidate-card')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '원문으로 돌아가기' })).toHaveCount(0);
    await expect(editor).toHaveValue(text);
    expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, text.length]);
    expect(requests).toEqual([text]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('drag and copy do not submit; floating action immediately submits the current selection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests: string[] = [];
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    requests.push(input.sourceText);
    await route.fulfill({ json: { ...input, candidates: [{ id: `drag-${requests.length}`, text: input.sourceText + ' 수정' }] } });
  });
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
  expect(requests).toHaveLength(0);
  const first = await editor.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  await floating.click();
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requests).toEqual([first]);
  await editor.press('Control+End');
  await editor.press('Shift+Home');
  await expect(floating).toBeVisible();
  await floating.click();
  await expect(page.locator('.candidate-text')).toHaveText('네 번째 줄입니다. 수정');
  expect(requests).toEqual([first, '네 번째 줄입니다.']);
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
    await page.mouse.up();
    const selected = await editor.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selected.length).toBeGreaterThan(0);
    const floating = page.getByRole('button', { name: '교정하기', exact: true });
    await expect(floating).toBeVisible();
    expect(requests).toHaveLength(0);
    await floating.click();
    await expect(page.locator('.candidate-card')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(requests).toEqual([selected]);
    await expect(editor).toHaveValue(source);
  });
}

for (const interruption of ['pointercancel', 'blur'] as const) {
  test(`interrupted drag ignores other pointers and allows keyboard selection after ${interruption}`, async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON();
      requests.push(input.sourceText);
      await route.fulfill({ json: { ...input, candidates: [{ id: 'interrupted', text: input.sourceText + ' 수정' }] } });
    });
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
    expect(requests).toHaveLength(0);
    await floating.click();
    await expect(page.locator('.candidate-card')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(requests).toEqual([source]);
    await expect(editor).toHaveValue(source);
  });
}

test('rapid activation submits only once while the correction is pending', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    requests.push(input.sourceText);
    await gate;
    await route.fulfill({ json: { ...input, candidates: [{ id: 'once', text: input.sourceText + ' 수정' }] } });
  });
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  await editor.fill('한 번만 교정합니다.');
  await editor.press('Control+a');
  await page.getByRole('button', { name: '교정 실행', exact: true }).evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole('button', { name: '교정 중', exact: true })).toBeDisabled();
  await expect(page.locator('.floating-correction')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  release();
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  expect(requests).toEqual(['한 번만 교정합니다.']);
});

test('editing the source discards an in-flight direct correction', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received: () => void = () => {};
  const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    expect(input.sourceText).toBe('처음 문장');
    received();
    await gate;
    await route.fulfill({ json: { ...input, candidates: [{ id: 'stale', text: '오래된 후보' }] } }).catch(() => {});
  });
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  await editor.fill('처음 문장');
  await editor.press('Control+a');
  await page.getByRole('button', { name: '교정 실행', exact: true }).click();
  await requested;
  await editor.fill('바뀐 원문');
  release();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(editor).toHaveValue('바뀐 원문');
  await expect(page.locator('.candidate-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '교정 실행', exact: true })).toBeDisabled();
});

for (const width of [1440, 390]) {
  test(`scrolled partial selection survives resize and immediate execution at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const prefix = '선택하지 않은 앞 문장입니다.\n'.repeat(40);
    const target = '목요일  오후 3시 😀에 회의합니다.\n참석 가능한 분들은\t수요일까지 알려주세요.\n자료를 확인해주세요.';
    const source = prefix + target + '\n선택하지 않은 뒤 문장입니다.';
    const requests: string[] = [];
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON();
      requests.push(input.sourceText);
      await route.fulfill({ json: { ...input, candidates: [{ id: 'partial', text: target + ' 수정' }] } });
    });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    await editor.fill(source);
    await editor.press('Control+End');
    await editor.evaluate((el: HTMLTextAreaElement, range) => el.setSelectionRange(range[0], range[1]), [prefix.length, prefix.length + target.length]);
    await editor.press('Shift');
    await page.setViewportSize({ width: width === 1440 ? 1000 : 430, height: 850 });
    await page.getByRole('button', { name: '교정 실행', exact: true }).click();
    await expect(page.locator('.candidate-card')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(requests).toEqual([target]);
    await expect(editor).toHaveValue(source);
    expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([prefix.length, prefix.length + target.length]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
