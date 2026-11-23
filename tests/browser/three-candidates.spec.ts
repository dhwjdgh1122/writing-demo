import { test, expect } from '@playwright/test';
import { HISTORY_KEY } from '../../client/src/lib/history';
import { startCorrection } from './selection-helpers';

test('three fresh candidates support explanations, third-candidate application and old one-candidate history', async ({ page }) => {
  const oldRecord = { id: 'old-request', createdAt: '2026-11-20T00:00:00.000Z', sourceText: '예전 원문.',
    candidates: [{ id: 'old-candidate', text: '예전 교정문.' }], explanations: [], appliedCandidateId: null, appliedAt: null };
  await page.addInitScript(({ key, record }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 1, records: [record] }));
  }, { key: HISTORY_KEY, record: oldRecord });
  const source = '금요일까지 자료를 보내 주세여.';
  const candidates = [
    { id: 'new-one', text: '금요일까지 자료를 보내 주세요.' },
    { id: 'new-two', text: '금요일까지 자료를 보내 주시기 바랍니다.' },
    { id: 'new-three', text: '자료를 금요일까지 보내 주세요.' },
  ];
  let correctionCalls = 0, explanationCalls = 0;
  await page.route('**/api/corrections', async route => {
    correctionCalls++;
    const input = route.request().postDataJSON();
    expect(input.sourceText).toBe(source);
    await route.fulfill({ json: { ...input, candidates } });
  });
  await page.route('**/api/explanations', async route => {
    explanationCalls++;
    const input = route.request().postDataJSON();
    expect(input.candidates).toEqual(candidates);
    await route.fulfill({ json: { ...input, explanations: candidates.map(candidate => ({
      candidateId: candidate.id, explanation: '보내 주세여를 보내 주세요 또는 보내 주시기 바랍니다로 다듬었습니다.',
    })) } });
  });
  await page.goto('/');
  const before = '앞 문장. ', after = ' 뒤 문장.';
  const editor = page.getByLabel('원문 입력');
  await editor.fill(before + source + after);
  await editor.evaluate((element: HTMLTextAreaElement, range) => {
    element.focus(); element.setSelectionRange(range[0], range[1]);
  }, [before.length, before.length + source.length]);
  await page.keyboard.press('Shift');
  await startCorrection(page);
  const cards = page.locator('.correction-view .candidate-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.locator('.candidate-text')).toHaveText(candidates.map(candidate => candidate.text));
  await page.getByRole('button', { name: '교정 이유', exact: true }).click();
  await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill('보내 주세여를 보내 주세요 또는 보내 주시기 바랍니다로 다듬었습니다.'));
  await cards.nth(2).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(editor).toHaveValue(before + candidates[2].text + after);
  await expect.poll(() => page.evaluate(key => {
    const records = JSON.parse(localStorage.getItem(key) || '{"records":[]}').records;
    return records.find((record: { id: string }) => record.id !== 'old-request')?.appliedCandidateId;
  }, HISTORY_KEY)).toBe('new-three');
  await page.reload();
  await page.getByRole('button', { name: '교정 이력', exact: true }).click();
  const entries = page.locator('.history-panel .history-entry');
  await expect(entries).toHaveCount(2);
  await entries.first().locator('summary').first().click();
  await expect(entries.first().locator('.candidate-card')).toHaveCount(3);
  await entries.last().locator('summary').first().click();
  await expect(entries.last().locator('.candidate-card')).toHaveCount(1);
  await expect(entries.last().locator('.candidate-text')).toHaveText('예전 교정문.');
  expect(correctionCalls).toBe(1);
  expect(explanationCalls).toBe(1);
});

test('incomplete candidate response reports the server error and waits for an explicit retry', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/corrections', async route => {
    calls++;
    const input = route.request().postDataJSON();
    await route.fulfill({ status: 502, json: { requestId: input.requestId, error: {
      code: 'MODEL_RESPONSE_INVALID', message: '교정 후보 3개를 완전하게 받지 못했습니다. 원문은 유지됩니다. 다시 실행해주세요.', retryable: true,
    } } });
  });
  await page.goto('/');
  const source = '금요일까지 자료를 보내 주세여.';
  const editor = page.getByLabel('원문 입력');
  await editor.fill(source);
  await editor.focus();
  await page.keyboard.press('Control+A');
  await startCorrection(page);
  await expect(page.locator('.correction-view').getByRole('status')).toContainText('교정 후보 3개를 완전하게 받지 못했습니다.');
  await expect(editor).toHaveValue(source);
  await expect(page.locator('.correction-view .candidate-card')).toHaveCount(0);
  expect(calls).toBe(1);
});
