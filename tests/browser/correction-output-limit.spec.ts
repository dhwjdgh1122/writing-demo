import { test, expect, type Page } from '@playwright/test';
import { expectSelected, startCorrection } from './selection-helpers';

async function selectRange(page: Page, start: number, end: number) {
  await page.getByLabel('원문 입력').evaluate((el: HTMLTextAreaElement, range) => {
    el.focus();
    el.setSelectionRange(range[0], range[1]);
  }, [start, end]);
  await page.keyboard.press('Shift');
}

test('truncated correction keeps the source and selection, then permits a smaller request', async ({ page }) => {
  const prefix = '앞 문장은 유지합니다.\n';
  const shorter = '금요일까지 자료를 보내 주세여.';
  const selected = shorter + '\n자료를 먼저 확인해 주세요.\n다음 주 회의에서 이야기하겠습니다.';
  const suffix = '\n뒤 문장도 유지합니다.';
  const source = prefix + selected + suffix;
  const corrected = '금요일까지 자료를 보내 주세요.';
  const requests: { requestId: string; sourceText: string }[] = [];
  let explanationCalls = 0;
  page.on('request', request => { if (request.url().endsWith('/api/explanations')) explanationCalls++; });
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    requests.push(input);
    if (requests.length === 1) {
      await route.fulfill({ status: 502, json: { requestId: input.requestId, error: {
        code: 'MODEL_OUTPUT_TRUNCATED',
        message: '교정 결과가 출력 한도에서 중단됐습니다. 원문은 유지됩니다. 선택 범위를 줄여 나누어 교정해주세요.',
        retryable: true,
      } } });
      return;
    }
    await route.fulfill({ json: { ...input, candidates: [{ id: 'shorter-request', text: corrected }] } });
  });
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  await editor.fill(source);
  await selectRange(page, prefix.length, prefix.length + selected.length);
  await startCorrection(page);
  await expect(page.locator('.error-message')).toContainText('교정 결과가 출력 한도에서 중단됐습니다.');
  await expect(page.locator('.error-message')).toContainText('선택 범위를 줄여 나누어 교정해주세요.');
  await expect(editor).toHaveValue(source);
  await expect(page.locator('.candidate-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이 문장 적용', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '교정 실행', exact: true })).toBeEnabled();
  await expectSelected(page, selected);
  expect(requests.map(request => request.sourceText)).toEqual([selected]);
  await selectRange(page, prefix.length, prefix.length + shorter.length);
  await startCorrection(page);
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  await expect(page.locator('.error-message')).toHaveCount(0);
  expect(requests.map(request => request.sourceText)).toEqual([selected, shorter]);
  expect(requests[0].requestId).not.toBe(requests[1].requestId);
  await page.getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(editor).toHaveValue(prefix + corrected + selected.slice(shorter.length) + suffix);
  expect(requests).toHaveLength(2);
  expect(explanationCalls).toBe(0);
});

test('truncated explanations keep the existing candidate available for comparison and application', async ({ page }) => {
  const source = '금요일까지 자료를 보내 주세여.';
  const corrected = '금요일까지 자료를 보내 주세요.';
  let correctionCalls = 0;
  let explanationCalls = 0;
  await page.route('**/api/corrections', async route => {
    correctionCalls++;
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'preserved-candidate', text: corrected }] } });
  });
  await page.route('**/api/explanations', async route => {
    explanationCalls++;
    const input = route.request().postDataJSON();
    expect(input.sourceText).toBe(source);
    expect(input.candidates).toEqual([{ id: 'preserved-candidate', text: corrected }]);
    await route.fulfill({ status: 502, json: { requestId: input.requestId, error: {
      code: 'MODEL_OUTPUT_TRUNCATED',
      message: '설명 결과가 출력 한도에서 중단됐습니다. 교정 후보는 유지되며 원문 비교와 적용은 계속할 수 있습니다. 필요하면 설명을 다시 요청해주세요.',
      retryable: true,
    } } });
  });
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  await editor.fill(source);
  await editor.press('Control+a');
  await startCorrection(page);
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  await page.getByRole('button', { name: /교정 이유/ }).click();
  await expect(page.locator('.explanation-error')).toContainText('설명 결과가 출력 한도에서 중단됐습니다.');
  await expect(page.locator('.explanation-error')).toContainText('원문 비교와 적용은 계속할 수 있습니다.');
  await expect(page.getByRole('button', { name: '설명 다시 시도', exact: true })).toBeEnabled();
  await expect(editor).toHaveValue(source);
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  await expect(page.locator('.candidate-explanation')).toHaveCount(0);
  await page.locator('.candidate-card summary').click();
  await expect(page.locator('.comparison-content')).toBeVisible();
  await expect(page.locator('.comparison del').first()).toBeVisible();
  const apply = page.getByRole('button', { name: '이 문장 적용', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(editor).toHaveValue(corrected);
  await expect(page.locator('.success-message')).toContainText('적용했습니다.');
  expect(correctionCalls).toBe(1);
  expect(explanationCalls).toBe(1);
});
