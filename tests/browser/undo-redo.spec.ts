import { test, expect, type Page } from '@playwright/test';

// Issue #3: exercise native browser history, not just reducer state.
// fill() sets an input value; it is not an OS clipboard or Korean IME test.

async function choose(page: Page, start: number, end: number) {
  await page.locator('#source-editor').evaluate((el: HTMLTextAreaElement, r) => {
    el.focus(); el.setSelectionRange(r[0], r[1]);
  }, [start, end]);
  await page.keyboard.press('Shift');
}
async function prepare(page: Page, source: string, typing = false) {
  await page.route('**/api/corrections', async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { ...body, candidates: [{ id: 'undo-fixture', text: body.sourceText + ' FIXED' }] } });
  });
  await page.goto('/');
  const editor = page.locator('#source-editor');
  if (typing) await editor.pressSequentially(source);
  else await editor.fill(source);
}
async function apply(page: Page, start: number, end: number) {
  await choose(page, start, end);
  await page.locator('.primary-button').click();
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  await page.getByRole('button', { name: '이 문장 적용', exact: true }).click();
}

for (const typing of [false, true]) {
  test(`selected range undo/redo, typing=${typing}`, async ({ page }) => {
    const source = 'Before. target. After. target. End.';
    await prepare(page, source, typing);
    const start = source.lastIndexOf('target.');
    await apply(page, start, start + 7);
    const editor = page.locator('#source-editor');
    const corrected = source.slice(0, start) + 'target. FIXED' + source.slice(start + 7);
    await expect(editor).toHaveValue(corrected);
    await expect(page.getByTestId('selected-text')).toHaveText('target. FIXED');
    for (let i = 0; i < 3; i++) {
      await editor.focus();
      await page.keyboard.press('Control+z');
      await expect(editor).toHaveValue(source);
      await expect(page.locator('.candidate-card')).toHaveCount(0);
      await page.keyboard.press('Control+y');
      await expect(editor).toHaveValue(corrected);
    }
  });
}

test('two corrections undo and redo independently', async ({ page }) => {
  await prepare(page, 'First. Second. Last.', true);
  await apply(page, 0, 6);
  await expect(page.locator('#source-editor')).toHaveValue('First. FIXED Second. Last.');
  await apply(page, 13, 20);
  const editor = page.locator('#source-editor');
  await expect(editor).toHaveValue('First. FIXED Second. FIXED Last.');
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveValue('First. FIXED Second. Last.');
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveValue('First. Second. Last.');
  await page.keyboard.press('Control+y');
  await expect(editor).toHaveValue('First. FIXED Second. Last.');
  await page.keyboard.press('Control+y');
  await expect(editor).toHaveValue('First. FIXED Second. FIXED Last.');
});

test('Korean multiline and emoji preserve surrounding text during undo/redo', async ({ page }) => {
  const source = '앞😀\n금요일까지 보내 주세여.\n뒤😀';
  await prepare(page, source);
  const start = source.indexOf('금');
  const end = source.lastIndexOf('\n');
  await apply(page, start, end);
  const editor = page.locator('#source-editor');
  await expect(editor).toHaveValue(source.slice(0, end) + ' FIXED' + source.slice(end));
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveValue(source);
  await page.keyboard.press('Control+y');
  await expect(editor).toHaveValue(source.slice(0, end) + ' FIXED' + source.slice(end));
});

test('applying a candidate restores focus to the correction button', async ({ page }) => {
  await prepare(page, 'First. Second.');
  await apply(page, 0, 6);
  await expect(page.locator('.primary-button')).toBeFocused();
});
