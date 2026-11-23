import { expect, test, type Page } from '@playwright/test';
import { getExplanationChanges } from '../../shared/explanation-changes';
import type { Explanation, ExplanationInput } from '../../shared/contracts';
import { startCorrection } from './selection-helpers';

const source = '자료를 적어 주세요. 회의는 다음주 목요일입니다.';
const candidate = '자료를 메모해 주세요. 회의는 다음 주 목요일입니다.';
const cards = (page: Page) => page.locator('.correction-view .candidate-card');
const reasonToggle = (page: Page) => page.locator('.explanation-toggle');

function reasons(input: ExplanationInput, longSecond = false): Explanation[] {
  return input.candidates.map(item => ({ candidateId: item.id, explanation: '원문과 교정안을 비교한 전체 설명입니다.',
    changes: getExplanationChanges(input.sourceText, item.text).map((change, index) => ({ changeId: change.id,
      title: index === 0 ? '기록 요청 표현' : `표현 변화 ${index + 1}`,
      explanation: index === 1 && longSecond ? '표현을 바꾸면서 전달하는 뜻이 달라질 수 있으므로 문맥을 확인하세요. '.repeat(4).trim() : '표현을 바꾸었습니다.',
    })) }));
}

async function setup(page: Page, options: { source?: string; texts?: string[]; failFirst?: boolean; longSecond?: boolean; legacy?: boolean } = {}) {
  const texts = options.texts ?? [candidate, candidate, candidate];
  const calls: ExplanationInput[] = [];
  let correctionCount = 0;
  await page.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON();
    correctionCount++;
    const output = input.targetCandidate ? [candidate.replace('메모해', '기록해')] : texts;
    await route.fulfill({ json: { ...input, candidates: output.map((text, index) => ({ id: `linked-${correctionCount}-${index}`, text })) } });
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    calls.push(input);
    if (options.failFirst && calls.length === 1) {
      await route.fulfill({ status: 503, json: { requestId: input.requestId,
        error: { code: 'MODEL_UNAVAILABLE', message: '테스트용 일시 오류입니다.', retryable: true } } });
      return;
    }
    const output = reasons(input, options.longSecond);
    await route.fulfill({ json: { ...input, explanations: options.legacy ? output.map(({ changes: _, ...item }) => item) : output } });
  });
  await page.goto('/');
  await page.getByLabel('원문 입력').fill(options.source ?? source);
  await page.getByLabel('원문 입력').evaluate((element: HTMLTextAreaElement) => {
    element.focus(); element.setSelectionRange(0, element.value.length);
  });
  await page.keyboard.press('Shift');
  await startCorrection(page);
  await expect(cards(page)).toHaveCount(texts.length);
  return calls;
}

for (const width of [1440, 390]) {
  test(`linked expressions preserve text, keyboard navigation and selection without more calls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1200 });
    const calls = await setup(page);
    const card = cards(page).first();
    await card.locator('.comparison > summary').click();
    await expect(card.locator('.expression-change')).toHaveCount(0);
    await reasonToggle(page).click();
    await expect(card.locator('.expression-reason-progress')).toHaveText('1 / 2');
    const paragraphs = card.locator('.comparison-content > p');
    expect(await paragraphs.nth(0).textContent()).toBe(source);
    expect(await paragraphs.nth(1).textContent()).toBe(candidate);
    expect(await card.locator('.candidate-text').textContent()).toBe(candidate);
    await expect(card.locator('.candidate-text [role="button"]')).toHaveCount(0);
    await expect(card.locator('.expression-change')).toHaveCount(4);

    const sourceChange = paragraphs.nth(0).getByRole('button').nth(1);
    await sourceChange.click();
    await expect(card.locator('.expression-reason-progress')).toHaveText('2 / 2');
    await expect(card.locator('.expression-change.is-active')).toHaveCount(2);
    const selectedIds = await card.locator('.expression-change.is-active').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-change-id')));
    expect(selectedIds[0]).toBe(selectedIds[1]);
    await expect(card.locator('.expression-reason-quotes dd').first()).toHaveText('다음주');
    await expect(card.locator('.expression-reason-quotes dd').last()).toHaveText('다음 주');
    await expect(card.getByRole('button', { name: '다음', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: '이전', exact: true }).click();
    await expect(card.locator('.expression-reason-progress')).toHaveText('1 / 2');
    await expect(card.getByRole('button', { name: '이전', exact: true })).toBeDisabled();

    const candidateChange = paragraphs.nth(1).getByRole('button').nth(1);
    await candidateChange.focus();
    await page.keyboard.press('Space');
    await expect(card.locator('.expression-reason-progress')).toHaveText('2 / 2');
    await paragraphs.nth(0).getByRole('button').first().focus();
    await page.keyboard.press('Enter');
    await expect(card.locator('.expression-reason-progress')).toHaveText('1 / 2');
    await card.getByRole('button', { name: '다음', exact: true }).click();
    await card.locator('.comparison > summary').click();
    await card.locator('.comparison > summary').click();
    await expect(card.locator('.expression-reason-progress')).toHaveText('2 / 2');
    await reasonToggle(page).click();
    await expect(card.locator('.expression-reason')).toHaveCount(0);
    await reasonToggle(page).click();
    await expect(card.locator('.expression-reason-progress')).toHaveText('2 / 2');
    expect(calls).toHaveLength(1);
    // Copying retains exact source content with no hidden ordinal labels inserted.
    const copied = await paragraphs.nth(0).evaluate(element => {
      const selection = getSelection()!;
      const range = document.createRange(); range.selectNodeContents(element);
      selection.removeAllRanges(); selection.addRange(range);
      const text = selection.toString(); selection.removeAllRanges(); return text;
    });
    expect(copied).toBe(source);
    // A pointer click ending a copy-selection must not select another explanation.
    await paragraphs.nth(0).getByRole('button').first().evaluate(element => {
      const selection = getSelection()!;
      const range = document.createRange(); range.selectNodeContents(element);
      selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    await expect(card.locator('.expression-reason-progress')).toHaveText('2 / 2');
    await page.evaluate(() => getSelection()?.removeAllRanges());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const controls = await card.locator('.expression-change').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-controls')));
    const otherControls = await cards(page).nth(1).locator('.expression-reason').getAttribute('id');
    expect(controls.every(id => id !== otherControls)).toBe(true);
    await card.screenshot({ path: `test-results/expression-reasons-${width}.png` });
  });
}

test('only explicit expression selection moves focus when the reason is outside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  const unchanged = '\n보조 문장은 그대로 둡니다.'.repeat(10);
  await setup(page, { source: source + unchanged, texts: [candidate + unchanged] });
  const card = cards(page).first();
  await reasonToggle(page).click();
  await card.locator('.comparison > summary').click();
  await card.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY);
  await card.locator('.expression-change-candidate').last().click();
  expect(await page.evaluate(() => scrollY)).toBe(before);
  await expect(card.locator('.expression-change-candidate').last()).toBeFocused();

  await page.setViewportSize({ width: 1440, height: 350 });
  const target = card.locator('.expression-change-source').first();
  await target.evaluate(element => element.scrollIntoView({ block: 'start' }));
  const panelBefore = await card.locator('.expression-reason').boundingBox();
  expect(panelBefore!.y).toBeGreaterThan(350);
  await target.click();
  await expect(card.locator('.expression-reason h4')).toBeFocused();
  const panelAfter = await card.locator('.expression-reason').boundingBox();
  expect(panelAfter!.y).toBeGreaterThanOrEqual(0);
  expect(panelAfter!.y).toBeLessThan(40);
  const afterScroll = await page.evaluate(() => scrollY);
  await card.getByRole('button', { name: '다음', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  expect(await page.evaluate(() => scrollY)).toBe(afterScroll);
});

test('reason panel height follows the selected explanation and does not retain empty space', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1200 });
  await setup(page, { texts: [candidate], longSecond: true });
  const card = cards(page).first();
  await reasonToggle(page).click();
  const panel = card.locator('.expression-reason');
  await expect(panel).toBeVisible();
  const short = (await panel.boundingBox())!.height;
  await card.getByRole('button', { name: '다음', exact: true }).click();
  const long = (await panel.boundingBox())!.height;
  expect(long).toBeGreaterThan(short + 80);
  await card.getByRole('button', { name: '이전', exact: true }).click();
  expect((await panel.boundingBox())!.height).toBeCloseTo(short, 0);
  const gap = await panel.evaluate(element => {
    const copy = element.querySelector('.expression-reason-detail')!.getBoundingClientRect();
    const navigation = element.querySelector('.expression-reason-navigation')!.getBoundingClientRect();
    return navigation.top - copy.bottom;
  });
  expect(gap).toBeLessThanOrEqual(20);
  await panel.screenshot({ path: 'test-results/expression-reason-short.png' });
});

test('failure retry stores linked reasons that remain navigable in history without another model call', async ({ page }) => {
  const calls = await setup(page, { texts: [candidate], failFirst: true });
  await reasonToggle(page).click();
  await page.getByRole('button', { name: '설명 다시 시도', exact: true }).click();
  await expect(cards(page).first().locator('.expression-reason-progress')).toHaveText('1 / 2');
  expect(calls).toHaveLength(2);
  await expect(page.locator('.history-panel:not(.activity-panel) .history-feedback')).toHaveText('이 브라우저에 저장되었습니다.');
  await page.reload();
  await page.getByRole('button', { name: '교정 이력', exact: true }).click();
  const history = page.locator('.history-panel:not(.activity-panel)');
  await history.locator('.history-entry > summary').click();
  await history.locator('.comparison > summary').click();
  await history.locator('.expression-change-candidate').last().click();
  await expect(history.locator('.expression-reason-progress')).toHaveText('2 / 2');
  expect(calls).toHaveLength(2);
});

test('legacy explanations remain whole paragraphs and are never assigned to a clicked phrase', async ({ page }) => {
  const calls = await setup(page, { texts: [candidate], legacy: true });
  const card = cards(page).first();
  await reasonToggle(page).click();
  await expect(card.getByRole('heading', { name: '전체 교정 이유' })).toBeVisible();
  await card.locator('.comparison > summary').click();
  await expect(card.locator('.expression-change')).toHaveCount(0);
  await expect(card.locator('.candidate-explanation p')).toHaveText('원문과 교정안을 비교한 전체 설명입니다.');
  await page.reload();
  await page.getByRole('button', { name: '교정 이력', exact: true }).click();
  const history = page.locator('.history-panel:not(.activity-panel)');
  await history.locator('.history-entry > summary').click();
  await expect(history.getByRole('heading', { name: '전체 교정 이유' })).toBeVisible();
  await expect(history.locator('.expression-change')).toHaveCount(0);
  expect(calls).toHaveLength(1);
});

test('single candidate rerun resets only the changed candidate explanation selection', async ({ page }) => {
  const calls = await setup(page);
  await reasonToggle(page).click();
  await expect(cards(page).first().locator('.expression-reason-progress')).toHaveText('1 / 2');
  await cards(page).first().getByRole('button', { name: '다음', exact: true }).click();
  await cards(page).nth(1).getByRole('button', { name: '다음', exact: true }).click();
  await cards(page).first().getByRole('button', { name: '다시 교정하기', exact: true }).click();
  await cards(page).first().getByRole('radio', { name: '더 담백하게', exact: true }).check();
  await cards(page).first().getByRole('button', { name: '교정 시작', exact: true }).click();
  await expect(cards(page).first().locator('.candidate-text')).toContainText('기록해');
  await expect(cards(page).first().locator('.expression-reason-progress')).toHaveText('1 / 2');
  await expect(cards(page).nth(1).locator('.expression-reason-progress')).toHaveText('2 / 2');
  expect(calls).toHaveLength(2);
});

for (const insert of [true, false]) {
  test(`${insert ? 'inserted' : 'deleted'} expression has one selectable side without fabricating a paired phrase`, async ({ page }) => {
    const before = insert ? '자료를 보내 주세요.' : '자료를 꼭 보내 주세요.';
    const after = insert ? '자료를 꼭 보내 주세요.' : '자료를 보내 주세요.';
    const calls = await setup(page, { source: before, texts: [after] });
    const card = cards(page).first();
    await reasonToggle(page).click();
    await card.locator('.comparison > summary').click();
    await expect(card.locator('.expression-change')).toHaveCount(1);
    await card.locator('.expression-change').click();
    await expect(card.locator('.expression-empty')).toHaveText(insert ? '대응 표현 없음 · 새로 추가됨' : '대응 표현 없음 · 삭제됨');
    await expect(card.locator('.expression-reason-progress')).toHaveText('1 / 1');
    await expect(card.getByRole('button', { name: '이전', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: '다음', exact: true })).toBeDisabled();
    expect(await card.locator('.comparison-content > p').first().textContent()).toBe(before);
    expect(await card.locator('.comparison-content > p').last().textContent()).toBe(after);
    expect(calls).toHaveLength(1);
  });
}

test('unmatched stored change IDs cannot attach a reason to the wrong expression', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/explanations', async route => { calls++; await route.abort(); });
  const record = { id: 'invalid-link-history', createdAt: '2026-11-23T00:00:00.000Z', sourceText: source,
    candidates: [{ id: 'stored-candidate', text: candidate }], appliedCandidateId: null, appliedAt: null,
    explanations: [{ candidateId: 'stored-candidate', explanation: '과거의 전체 교정 설명입니다.',
      changes: [{ changeId: 'change-invalid-link', title: '잘못 연결된 설명', explanation: '다른 문장에 대한 설명입니다.' }] }] };
  await page.addInitScript(value => localStorage.setItem('writing-demo.correction-history.v1', JSON.stringify({ version: 1, records: [value] })), record);
  await page.goto('/');
  await page.getByRole('button', { name: '교정 이력', exact: true }).click();
  const history = page.locator('.history-panel:not(.activity-panel)');
  await history.locator('.history-entry > summary').click();
  await history.locator('.comparison > summary').click();
  await expect(history.locator('.expression-change')).toHaveCount(0);
  await expect(history.locator('.expression-reason')).toHaveCount(0);
  await expect(history.getByText('다른 문장에 대한 설명입니다.', { exact: true })).toHaveCount(0);
  await expect(history.getByRole('heading', { name: '전체 교정 이유' })).toBeVisible();
  expect(calls).toBe(0);
});
