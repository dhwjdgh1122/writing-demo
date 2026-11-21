import { startCorrection, expectSelected } from './selection-helpers';
import { test, expect, type Page } from '@playwright/test';

async function select(page: Page, start: number, end: number) {
  await page.getByLabel('원문 입력').evaluate((el: HTMLTextAreaElement, range) => { el.focus(); el.setSelectionRange(range[0], range[1]); }, [start, end]);
  // React's selection plugin observes real keyboard/mouse events, not synthetic select alone.
  await page.keyboard.press('Shift');
}
test('real unconfigured server: selection persists on panel click and reports missing AI', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '교정 실행' })).toBeDisabled();
  await page.getByLabel('원문 입력').fill('앞 문장. 교정할 문장입니다. 뒤 문장.');
  await select(page, 6, 6 + '교정할 문장입니다.'.length);
  await page.getByRole('heading', { name: '원문 작업 공간' }).click();
  await expectSelected(page, '교정할 문장입니다.');
  await startCorrection(page);
  await expect(page.locator('.correction-view').getByRole('status')).toContainText('AI 연결 설정이 필요합니다');
  await expect(page.getByLabel('원문 입력')).toHaveValue('앞 문장. 교정할 문장입니다. 뒤 문장.');
});
test('test-only API response: compares and applies only the selected repeated occurrence', async ({ page }) => {
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    expect(Object.keys(input).sort()).toEqual(['requestId', 'sourceText']);
    await route.fulfill({ json: { ...input, candidates: [{ id: 'fixture1', text: '목요일에 안내하겠습니다.' }, { id: 'fixture2', text: input.sourceText }] } });
  });
  await page.goto('/');
  const source = '첫째. 이후에 안내하겠습니다. 중간. 이후에 안내하겠습니다. 끝.';
  const target = '이후에 안내하겠습니다.';
  const start = source.lastIndexOf(target);
  await page.getByLabel('원문 입력').fill(source);
  await select(page, start, start + target.length);
  await startCorrection(page);
  await expect(page.locator('.candidate-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '변경 없음' })).toBeDisabled();
  await page.locator('summary').first().click();
  await expect(page.locator('.comparison del').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/candidates-test-response.png', fullPage: true });
  await page.getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue(source.slice(0, start) + '목요일에 안내하겠습니다.' + source.slice(start + target.length));
  await expect(page.locator('.correction-view').getByRole('status')).toContainText('적용했습니다');
  await expect(page.locator('.candidate-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '적용한 내용을 확인해주세요' })).toBeVisible();
  await expect(page.locator('#selection-help')).toHaveText('원문에 반영된 내용을 확인해주세요.');
  await expect(page.getByRole('heading', { name: '교정할 준비가 되었습니다' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/applied-guidance.png', fullPage: true });
  await select(page, 0, 3);
  await expect(page.getByRole('heading', { name: '교정할 준비가 되었습니다' })).toBeVisible();
  await expect(page.locator('.correction-view').getByRole('status')).toHaveCount(0);
  await page.getByRole('button', { name: '선택 해제' }).click();
  await expect(page.getByRole('heading', { name: '문장을 선택하면 시작됩니다' })).toBeVisible();
});
test('selection change removes old results and ignores delayed results', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received: () => void = () => {};
  const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/corrections', async route => { const body = route.request().postDataJSON(); received(); await gate; await route.fulfill({ json: { ...body, candidates: [{ id: 'late', text: '늦은 후보' }] } }).catch(() => {}); });
  await page.goto('/');
  await page.getByLabel('원문 입력').fill('첫째 둘째');
  await select(page, 0, 2);
  await startCorrection(page);
  await requested;
  await select(page, 3, 5);
  release();
  await expectSelected(page, '둘째');
  await expect(page.getByRole('button', { name: '교정 실행' })).toBeEnabled();
  await expect(page.locator('.candidate-card')).toHaveCount(0);
});
test('limits, clear action and Korean composition guard', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('원문 입력').fill('가'.repeat(1001));
  await select(page, 0, 1001);
  await expect(page.getByRole('button', { name: '교정 실행' })).toBeDisabled();
  await expect(page.locator('#selection-help')).toContainText('1,000자');
  await select(page, 0, 1000);
  await expect(page.getByRole('button', { name: '교정 실행' })).toBeEnabled();
  await page.getByLabel('원문 입력').dispatchEvent('compositionstart');
  await expect(page.getByRole('button', { name: '교정 실행' })).toBeDisabled();
  await page.getByLabel('원문 입력').dispatchEvent('compositionend');
  await page.getByRole('button', { name: '선택 해제' }).click();
  await expect(page.getByRole('button', { name: '교정 실행' })).toBeDisabled();
});
test('real mouse drag and keyboard selection update the correction panel', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  await editor.fill('마우스로 선택하는 문장입니다.\n키보드 선택도 확인합니다.');
  const box = await editor.boundingBox();
  if (!box) throw new Error('Editor not visible');
  await page.mouse.move(box.x + 18, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 190, box.y + 30, { steps: 12 });
  await page.mouse.up();
  const selection = await editor.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  expect(selection.trim().length).toBeGreaterThan(0);
  await expectSelected(page, selection);
  await editor.press('Control+Home');
  await editor.press('Shift+End');
  await expectSelected(page, '마우스로 선택하는 문장입니다.');
});
test('selection scope survives focus and caret moves; requests follow the latest selection only', async ({ page, browser }) => {
  console.info(`Selection scope check: Edge ${browser.version()}`);
  const requests: { requestId: string; sourceText: string }[] = [];
  let explanationSource = '';
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    expect(Object.keys(input).sort()).toEqual(['requestId', 'sourceText']);
    requests.push(input);
    await route.fulfill({ json: { ...input, candidates: [{ id: 'scope', text: `${input.sourceText} 수정` }] } });
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON();
    expect(Object.keys(input).sort()).toEqual(['candidates', 'requestId', 'sourceText']);
    explanationSource = input.sourceText;
    expect(input.candidates).toEqual([{ id: 'scope', text: '첫 문장은 주변 정보입니다. 수정' }]);
    await route.fulfill({ json: { ...input, explanations: [{ candidateId: 'scope', explanation: '테스트용 설명입니다.' }] } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const editor = page.getByLabel('원문 입력');
  const selected = page.getByTestId('selected-text');
  const run = page.getByRole('button', { name: '교정 실행', exact: true });
  const source = '첫 문장은 주변 정보입니다.\n금요일까지 자료를 보내 주세여.\n마지막 문장도 주변 정보입니다.';
  await editor.fill(source);
  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('Home');
  await editor.press('Shift+End');
  await expectSelected(page, '금요일까지 자료를 보내 주세여.');
  await page.getByRole('heading', { name: '원문 작업 공간' }).click();
  await run.focus();
  await expectSelected(page, '금요일까지 자료를 보내 주세여.');
  await editor.focus();
  await editor.press('Control+Home');
  expect(await editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.selectionEnd)).toBe(true);
  await expectSelected(page, '금요일까지 자료를 보내 주세여.');
  await startCorrection(page);
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  expect(requests.map(input => input.sourceText)).toEqual(['금요일까지 자료를 보내 주세여.']);
  await editor.focus();
  await editor.press('Control+Home');
  await editor.press('Shift+End');
  await expectSelected(page, '첫 문장은 주변 정보입니다.');
  await expect(page.locator('.candidate-card')).toHaveCount(0);
  await startCorrection(page);
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  expect(requests.map(input => input.sourceText)).toEqual(['금요일까지 자료를 보내 주세여.', '첫 문장은 주변 정보입니다.']);
  expect(requests[1].requestId).not.toBe(requests[0].requestId);
  await page.getByRole('button', { name: /교정 이유/ }).click();
  await expect(page.locator('.candidate-explanation')).toContainText('테스트용 설명');
  expect(explanationSource).toBe('첫 문장은 주변 정보입니다.');
  await page.screenshot({ path: 'test-results/selection-scope.png', fullPage: true });
  await page.getByRole('button', { name: '선택 해제' }).click();
  await expectSelected(page, '아직 선택한 문장이 없습니다.');
  await expect(run).toBeDisabled();
  await expect(page.locator('.candidate-card')).toHaveCount(0);
  await editor.focus();
  await editor.press('Control+Home');
  await editor.press('Shift+End');
  await expect(run).toBeEnabled();
  await editor.press('End');
  await editor.press('!');
  await expectSelected(page, '아직 선택한 문장이 없습니다.');
  await expect(run).toBeDisabled();
  expect(requests).toHaveLength(2);
});
for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`layout ${size.width}: no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '원문 작업 공간' })).toBeVisible();
    await expect(page.getByText('AI 연결 대기', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/workspace-${size.width}.png`, fullPage: true });
  });
}
async function prepareExplanation(page: Page) {
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, candidates: [{ id: 'date', text: '이후에 안내하겠습니다.' }, { id: 'same', text: input.sourceText }] } });
  });
  await page.goto('/');
  await page.getByLabel('원문 입력').fill('앞 문장. 목요일에 안내하겠습니다. 뒤 문장.');
  await select(page, 6, 6 + '목요일에 안내하겠습니다.'.length);
  await startCorrection(page);
  await expect(page.locator('.candidate-card')).toHaveCount(2);
}

test('explanations are opt-in, mapped by ID, cached on reopen, and allow applying', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/explanations', async route => {
    calls++;
    const input = route.request().postDataJSON();
    expect(Object.keys(input).sort()).toEqual(['candidates', 'requestId', 'sourceText']);
    expect(input.sourceText).toBe('목요일에 안내하겠습니다.');
    await route.fulfill({ json: { ...input, explanations: [
      { candidateId: 'same', explanation: '원문과 동일합니다.' },
      { candidateId: 'date', explanation: '목요일이 이후로 바뀌어 안내 날짜가 불분명해졌습니다.' },
    ] } });
  });
  await prepareExplanation(page);
  expect(calls).toBe(0);
  await expect(page.locator('.candidate-explanation')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: /교정 이유/ });
  await toggle.click();
  await expect(page.locator('.candidate-card').first().locator('.candidate-explanation')).toContainText('불분명');
  await expect(page.locator('.candidate-card').last().locator('.candidate-explanation')).toContainText('동일');
  await page.screenshot({ path: 'test-results/explanations-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/explanations-mobile.png', fullPage: true });
  await toggle.click();
  await expect(page.locator('.candidate-explanation')).toHaveCount(0);
  await toggle.click();
  await expect(page.locator('.candidate-explanation')).toHaveCount(2);
  expect(calls).toBe(1);
  await page.getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue('앞 문장. 이후에 안내하겠습니다. 뒤 문장.');
  await expect(toggle).toHaveCount(0);
});

test('wrong explanation IDs show an isolated error and can be retried without regenerating candidates', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON();
    calls++;
    await route.fulfill({ json: { ...input, explanations: calls === 1 ? [{ candidateId: 'wrong', explanation: '붙이면 안 되는 설명' }] : input.candidates.map((c: { id: string }) => ({ candidateId: c.id, explanation: '재시도 설명' })) } });
  });
  await prepareExplanation(page);
  await page.getByRole('button', { name: /교정 이유/ }).click();
  await expect(page.locator('.explanation-error')).toContainText('일치하는 설명');
  await expect(page.locator('.candidate-explanation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이 문장 적용', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '설명 다시 시도' }).click();
  await expect(page.locator('.candidate-explanation')).toHaveCount(2);
  expect(calls).toBe(2);
});

for (const action of ['apply', 'edit', 'select', 'rerun'] as const) {
  test(`late explanation is discarded after ${action}`, async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let received: () => void = () => {};
    const requested = new Promise<void>(resolve => { received = resolve; });
    await page.route('**/api/explanations', async route => {
      const input = route.request().postDataJSON(); received(); await gate;
      await route.fulfill({ json: { ...input, explanations: input.candidates.map((c: { id: string }) => ({ candidateId: c.id, explanation: '오래된 설명' })) } }).catch(() => {});
    });
    await prepareExplanation(page);
    await page.getByRole('button', { name: /교정 이유/ }).click();
    await requested;
    if (action === 'apply') await page.getByRole('button', { name: '이 문장 적용', exact: true }).click();
    if (action === 'edit') await page.getByLabel('원문 입력').fill('새 원문');
    if (action === 'select') await select(page, 0, 5);
    if (action === 'rerun') await startCorrection(page);
    release();
    await expect(page.getByText('오래된 설명', { exact: true })).toHaveCount(0);
    if (action === 'rerun') {
      await expect(page.locator('.candidate-card')).toHaveCount(2);
      await expect(page.getByRole('button', { name: /교정 이유/ })).toHaveAttribute('aria-expanded', 'false');
    } else await expect(page.locator('.candidate-card')).toHaveCount(0);
  });
}
test('quotation validation error keeps candidates available and retries only explanations', async ({ page }) => {
  let corrections = 0;
  let explanations = 0;
  page.on('request', request => { if (request.url().endsWith('/api/corrections')) corrections++; });
  await page.route('**/api/explanations', async route => {
    explanations++;
    const input = route.request().postDataJSON();
    if (explanations === 1) await route.fulfill({ status: 502, json: { requestId: input.requestId, error: {
      code: 'EXPLANATION_QUOTE_MISMATCH', message: '설명에 원문·교정안과 맞지 않는 인용이 있어 표시하지 않았습니다. 후보는 그대로 사용할 수 있습니다. 설명을 다시 요청해주세요.', retryable: true,
    } } });
    else await route.fulfill({ json: { ...input, explanations: input.candidates.map((c: { id: string }) => ({ candidateId: c.id, explanation: '재시도 설명' })) } });
  });
  await prepareExplanation(page);
  await page.getByRole('button', { name: /교정 이유/ }).click();
  await expect(page.locator('.explanation-error')).toContainText('맞지 않는 인용');
  await expect(page.locator('.candidate-explanation')).toHaveCount(0);
  await expect(page.locator('.candidate-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '이 문장 적용', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '설명 다시 시도' }).click();
  await expect(page.locator('.candidate-explanation')).toHaveCount(2);
  expect(corrections).toBe(1);
  expect(explanations).toBe(2);
});

test('partial explanations preserve success through retry failures and retry only failed IDs', async ({ page }) => {
  let corrections = 0;
  const requests: string[][] = [];
  page.on('request', request => { if (request.url().endsWith('/api/corrections')) corrections++; });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON();
    requests.push(input.candidates.map((c: { id: string }) => c.id));
    if (requests.length === 2) {
      await route.fulfill({ status: 503, json: { requestId: input.requestId, error: { code: 'MODEL_UNAVAILABLE', message: '잠시 후 다시 시도해주세요.', retryable: true } } });
      return;
    }
    await route.fulfill({ json: { ...input, explanations: requests.length === 1 ? [
      { candidateId: 'same', explanation: '보존할 정상 설명입니다.' },
      { candidateId: 'date', error: 'EXPLANATION_QUOTE_MISMATCH' },
    ] : [{ candidateId: 'date', explanation: '재시도한 날짜 설명입니다.' }] } });
  });
  await prepareExplanation(page);
  const toggle = page.getByRole('button', { name: /교정 이유/ });
  await toggle.click();
  await expect(page.locator('.candidate-card').first()).toContainText('이 후보의 설명을 표시하지 않았습니다');
  await expect(page.locator('.candidate-card').last()).toContainText('보존할 정상 설명');
  await expect(page.locator('.explanation-error')).toContainText('일부 후보');
  await page.screenshot({ path: 'test-results/explanations-partial-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/explanations-partial-mobile.png', fullPage: true });
  await toggle.click();
  await toggle.click();
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: '실패한 설명 다시 시도' }).click();
  await expect(page.locator('.explanation-error')).toContainText('잠시 후');
  await expect(page.locator('.candidate-card').last()).toContainText('보존할 정상 설명');
  await page.getByRole('button', { name: '설명 다시 시도', exact: true }).click();
  await expect(page.locator('.candidate-card').first()).toContainText('재시도한 날짜 설명');
  await expect(page.locator('.candidate-card').last()).toContainText('보존할 정상 설명');
  await expect(page.locator('.explanation-error')).toHaveCount(0);
  expect(requests).toEqual([['date', 'same'], ['date'], ['date']]);
  expect(corrections).toBe(1);
  await page.getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue('앞 문장. 이후에 안내하겠습니다. 뒤 문장.');
});

test('all candidate failures remain visible as failures and applying still works', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/explanations', async route => {
    calls++;
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, explanations: input.candidates.map((c: { id: string }) => ({ candidateId: c.id, error: 'EXPLANATION_INVALID' })) } });
  });
  await prepareExplanation(page);
  await page.getByRole('button', { name: /교정 이유/ }).click();
  await expect(page.locator('.explanation-error')).toContainText('교정 이유를 표시하지 못했습니다');
  await expect(page.getByText('이 후보의 설명 형식을 확인하지 못해 표시하지 않았습니다.', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: '원문 비교 확인' })).toHaveCount(0);
  expect(calls).toBe(1);
  await page.getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue('앞 문장. 이후에 안내하겠습니다. 뒤 문장.');
});

test('a delayed failed-only retry is discarded when the selection changes', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received: () => void = () => {};
  const requested = new Promise<void>(resolve => { received = resolve; });
  let calls = 0;
  await page.route('**/api/explanations', async route => {
    calls++;
    const input = route.request().postDataJSON();
    if (calls === 1) {
      await route.fulfill({ json: { ...input, explanations: [
        { candidateId: 'date', error: 'EXPLANATION_INVALID' }, { candidateId: 'same', explanation: '변경 없음' },
      ] } });
    } else {
      expect(input.candidates.map((c: { id: string }) => c.id)).toEqual(['date']);
      received(); await gate;
      await route.fulfill({ json: { ...input, explanations: [{ candidateId: 'date', explanation: '늦게 도착한 재시도 설명' }] } }).catch(() => {});
    }
  });
  await prepareExplanation(page);
  await page.getByRole('button', { name: /교정 이유/ }).click();
  await page.getByRole('button', { name: '실패한 설명 다시 시도' }).click();
  await requested;
  await select(page, 0, 5);
  release();
  await expect(page.locator('.candidate-card')).toHaveCount(0);
  await expect(page.getByText('늦게 도착한 재시도 설명', { exact: true })).toHaveCount(0);
});
