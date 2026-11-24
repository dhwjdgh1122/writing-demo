import { expect, test, type Page, type Route } from '@playwright/test';
import type { Candidate, CorrectionInput, ExplanationInput, ExplanationResult } from '../../shared/contracts';
import { startCorrection } from './selection-helpers';

const source = '자료를 보내 주세여.';
const initial: Candidate[] = [
  { id: 'c1', text: '자료를 보내 주세요.' },
  { id: 'c2', text: '자료 전달을 부탁드립니다.' },
  { id: 'c3', text: '자료를 보내 주시겠어요?' },
];
const revised: Candidate = { id: 'c1-revised', text: '자료를 보내 주시면 감사하겠습니다.' };
const cards = (page: Page) => page.locator('.correction-view .candidate-card');
const toggle = (page: Page) => page.getByRole('button', { name: '교정 이유', exact: true });
const requestRetry = (page: Page) => page.getByRole('button', { name: '설명 다시 시도', exact: true });
const failedRetry = (page: Page) => page.getByRole('button', { name: '실패한 설명 다시 시도', exact: true });
const success = (candidateId: string): ExplanationResult => ({ candidateId, explanation: `${candidateId}의 보존할 정상 설명입니다.` });
const failure = (candidateId: string): ExplanationResult => ({ candidateId, error: 'EXPLANATION_INVALID' });

async function unavailable(route: Route, input: ExplanationInput) {
  await route.fulfill({ status: 503, json: { requestId: input.requestId,
    error: { code: 'MODEL_UNAVAILABLE', message: '테스트용 일시 오류입니다.', retryable: true } } });
}

async function prepare(page: Page) {
  const corrections: CorrectionInput[] = [];
  await page.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON() as CorrectionInput;
    corrections.push(input);
    await route.fulfill({ json: { ...input, candidates: input.targetCandidate ? [revised] : initial } });
  });
  await page.goto('/');
  await page.getByLabel('원문 입력').fill(source);
  await page.getByLabel('원문 입력').evaluate((element: HTMLTextAreaElement) => {
    element.focus(); element.setSelectionRange(0, element.value.length);
  });
  await page.keyboard.press('Shift');
  await startCorrection(page);
  await expect(cards(page)).toHaveCount(3);
  return corrections;
}

async function expectSuccess(page: Page, index: number, id: string) {
  await expect(cards(page).nth(index).locator('.candidate-explanation > p')).toHaveText(`${id}의 보존할 정상 설명입니다.`);
}

test('three candidates recover from request and partial failures without losing successful explanations or retry controls', async ({ page }) => {
  const calls: ExplanationInput[] = [];
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    calls.push(input);
    if (calls.length === 1 || calls.length === 3) {
      await unavailable(route, input);
      return;
    }
    const output = calls.length === 2 ? [failure('c1'), failure('c2'), success('c3')]
      : calls.length === 4 ? [success('c1'), failure('c2')] : [success('c2')];
    await route.fulfill({ json: { ...input, explanations: output } });
  });
  const corrections = await prepare(page);
  await toggle(page).click();
  await expect(requestRetry(page)).toBeEnabled();
  await expect(cards(page).locator('.candidate-explanation')).toHaveCount(0);

  await requestRetry(page).click();
  await expect(failedRetry(page)).toBeEnabled();
  for (const index of [0, 1]) await expect(cards(page).nth(index)).toContainText('설명 형식을 확인하지 못해');
  await expectSuccess(page, 2, 'c3');
  // Reopening the view is not another paid request; explicit retry stays available.
  await toggle(page).click();
  await toggle(page).click();
  await expect(failedRetry(page)).toBeEnabled();
  expect(calls).toHaveLength(2);

  await failedRetry(page).click();
  await expect(requestRetry(page)).toBeEnabled();
  await expectSuccess(page, 2, 'c3');
  await requestRetry(page).click();
  await expect(failedRetry(page)).toBeEnabled();
  await expectSuccess(page, 0, 'c1');
  await expectSuccess(page, 2, 'c3');
  await expect(cards(page).nth(1)).toContainText('설명 형식을 확인하지 못해');

  await failedRetry(page).click();
  for (const [index, candidate] of initial.entries()) await expectSuccess(page, index, candidate.id);
  await expect(page.locator('.explanation-error')).toHaveCount(0);
  await toggle(page).click();
  await toggle(page).click();
  await expectSuccess(page, 2, 'c3');
  expect(calls.map(input => input.candidates.map(candidate => candidate.id))).toEqual([
    ['c1', 'c2', 'c3'], ['c1', 'c2', 'c3'], ['c1', 'c2'], ['c1', 'c2'], ['c2'],
  ]);
  expect(new Set(calls.map(input => input.requestId)).size).toBe(5);
  expect(corrections).toHaveLength(1);
  await expect(cards(page).locator('.candidate-text')).toHaveText(initial.map(candidate => candidate.text));
  await expect(page.getByLabel('원문 입력')).toHaveValue(source);
});

test('mixed-origin explanation failures retry only unresolved candidates and preserve their generation context', async ({ page }) => {
  const calls: ExplanationInput[] = [];
  const counts = { original: 0, revised: 0 };
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    calls.push(input);
    const group = input.targetCandidate ? 'revised' : 'original';
    const attempt = ++counts[group];
    if (group === 'revised' && attempt === 1 || group === 'original' && attempt === 2) {
      await unavailable(route, input);
      return;
    }
    const output = group === 'original' && attempt === 1
      ? [failure('c2'), success('c3')] : input.candidates.map(candidate => success(candidate.id));
    await route.fulfill({ json: { ...input, explanations: output } });
  });
  const corrections = await prepare(page);
  await cards(page).first().getByRole('button', { name: '다시 교정하기', exact: true }).click();
  const rerun = page.getByRole('region', { name: '재교정 요청', exact: true });
  await rerun.locator('input[value="polite"]').check();
  await rerun.getByRole('button', { name: '교정 시작', exact: true }).click();
  await expect(cards(page).locator('.candidate-text')).toHaveText([revised.text, initial[1].text, initial[2].text]);
  expect(calls).toHaveLength(0);

  await toggle(page).click();
  await expect(requestRetry(page)).toBeEnabled();
  await expectSuccess(page, 2, 'c3');
  await expect(cards(page).nth(1)).toContainText('설명 형식을 확인하지 못해');
  expect(counts).toEqual({ original: 1, revised: 1 });
  await toggle(page).click();
  await toggle(page).click();
  await expect(requestRetry(page)).toBeEnabled();
  expect(calls).toHaveLength(2);

  await requestRetry(page).click();
  await expect(requestRetry(page)).toBeEnabled();
  await expectSuccess(page, 0, revised.id);
  await expectSuccess(page, 2, 'c3');
  expect(counts).toEqual({ original: 2, revised: 2 });
  await requestRetry(page).click();
  for (const [index, candidate] of [revised, initial[1], initial[2]].entries()) await expectSuccess(page, index, candidate.id);
  await expect(page.locator('.explanation-error')).toHaveCount(0);

  const originalCalls = calls.filter(input => !input.targetCandidate);
  const revisedCalls = calls.filter(input => input.targetCandidate);
  expect(originalCalls.map(input => input.candidates.map(candidate => candidate.id))).toEqual([['c2', 'c3'], ['c2'], ['c2']]);
  expect(revisedCalls.map(input => input.candidates)).toEqual([[revised], [revised]]);
  for (const input of revisedCalls) expect(input).toMatchObject({ sourceText: source,
    targetCandidate: initial[0], retryContext: corrections[1].retryContext });
  for (const input of originalCalls) {
    expect(input.sourceText).toBe(source);
    expect(input.retryContext).toBeUndefined();
  }
  await toggle(page).click();
  await toggle(page).click();
  await expectSuccess(page, 0, revised.id);
  expect(calls).toHaveLength(5);
  expect(new Set(calls.map(input => input.requestId)).size).toBe(5);
  expect(corrections).toHaveLength(2);
  await expect(cards(page).locator('.candidate-text')).toHaveText([revised.text, initial[1].text, initial[2].text]);
  await expect(page.getByLabel('원문 입력')).toHaveValue(source);
});
