import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Candidate, CorrectionInput, ExplanationInput } from '../../shared/contracts';
import type { HistoryRecord } from '../../client/src/lib/history';
import type { ActivityEvent } from '../../client/src/lib/activity';
import { startCorrection } from './selection-helpers';

const results = (page: Page) => page.locator('.correction-view');
const history = (page: Page) => page.locator('.history-panel:not(.activity-panel)');
const activity = (page: Page) => page.locator('.activity-panel');
const rerun = (page: Page) => page.getByRole('region', { name: '재교정 요청', exact: true });
const requirement = (page: Page, value: string) => rerun(page).locator(`input[type="radio"][value="${value}"]`);
const rerunButton = (page: Page) => rerun(page).getByRole('button', { name: /^(교정 시작|다시 시도|교정 중)/ });
const rerunToggle = (page: Page, candidateIndex = 0) => results(page).getByRole('button', { name: '다시 교정하기', exact: true }).nth(candidateIndex);
const explanationText = '테스트에서 주입한 교정 설명입니다.';
const failureText = '테스트용 교정 오류: 로그에 보관하면 안 되는 상세 문구';

type ExportedActivity = {
  version: number; contentIncluded: boolean;
  events: (ActivityEvent & { content?: Pick<HistoryRecord, 'sourceText' | 'candidates' | 'explanations'> })[];
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function selectRange(page: Page, start: number, end: number) {
  await page.getByLabel('원문 입력').evaluate((element: HTMLTextAreaElement, range) => {
    element.focus(); element.setSelectionRange(range[0], range[1]);
  }, [start, end]);
  await page.keyboard.press('Shift');
}

async function firstCorrection(page: Page, text: string, selection = text) {
  await page.getByLabel('원문 입력').fill(text);
  const start = text.indexOf(selection);
  await selectRange(page, start, start + selection.length);
  await startCorrection(page);
  await expect(results(page).locator('.candidate-card')).not.toHaveCount(0);
  await expect(rerunToggle(page)).toBeVisible();
  await expect(rerun(page)).toHaveCount(0);
}

async function openRerun(page: Page) {
  if (!await rerun(page).isVisible()) await rerunToggle(page).click();
  await expect(rerun(page)).toBeVisible();
}

async function selectRequirement(page: Page, value: string) {
  await openRerun(page);
  await requirement(page, value).check();
}

async function runRerun(page: Page) {
  await openRerun(page);
  await rerunButton(page).click();
}

async function mockModels(page: Page, outputs: (string[] | 'failure')[], beforeReply?: (input: CorrectionInput, index: number) => Promise<void>, beforeExplanation?: (input: ExplanationInput, index: number) => Promise<void>) {
  const corrections: CorrectionInput[] = [];
  const explanations: ExplanationInput[] = [];
  const candidates: Candidate[][] = [];
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON() as CorrectionInput;
    corrections.push(input);
    const index = corrections.length - 1;
    if (beforeReply) await beforeReply(input, index);
    const output = outputs[index];
    if (!output) throw new Error(`Unexpected correction request ${index + 1}`);
    if (output === 'failure') {
      candidates[index] = [];
      await route.fulfill({ status: 503, json: { requestId: input.requestId,
        error: { code: 'MODEL_UNAVAILABLE', message: failureText, retryable: true } } }).catch(() => {});
    } else {
      candidates[index] = output.map((text, candidateIndex) => ({ id: `candidate-${index + 1}-${candidateIndex + 1}`, text }));
      await route.fulfill({ json: { ...input, candidates: candidates[index] } }).catch(() => {});
    }
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    explanations.push(input);
    if (beforeExplanation) await beforeExplanation(input, explanations.length - 1);
    await route.fulfill({ json: { ...input, explanations: input.candidates.map(candidate => ({ candidateId: candidate.id, explanation: explanationText })) } });
  });
  return { corrections, explanations, candidates };
}

async function downloadText(page: Page, panel: Locator, button: string) {
  const pending = page.waitForEvent('download');
  await panel.getByRole('button', { name: button, exact: true }).click();
  const download = await pending;
  const file = await download.path();
  if (!file) throw new Error('Download file is unavailable');
  return readFile(file, 'utf8');
}

async function historyRecords(page: Page): Promise<HistoryRecord[]> {
  const wasOpen = await history(page).isVisible();
  if (!wasOpen) await page.getByRole('button', { name: '교정 이력', exact: true }).click();
  const records = JSON.parse(await downloadText(page, history(page), 'JSON 내보내기')).records;
  if (!wasOpen) await history(page).getByRole('button', { name: '교정 문장으로 돌아가기', exact: true }).click();
  return records;
}

async function activityRecords(page: Page): Promise<ExportedActivity> {
  return JSON.parse(await downloadText(page, activity(page), '행동 JSON 내보내기'));
}

// Read exported CSV as a spreadsheet would, including quoted commas, newlines and quotes.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') { row.push(field); field = ''; }
    else if (!quoted && character === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (quoted || character !== '\r') field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map(columns => Object.fromEntries(headers.map((name, index) => [name, columns[index]])));
}

test.beforeEach(async ({ context }) => {
  await context.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
});

test('before application, an optional requirement revises only its chosen candidate and explanations retain each origin', async ({ page }) => {
  const source = '금요일까지 자료를 보내 주세여.';
  const calls = await mockModels(page, [['금요일까지 자료를 보내 주세요.', '금요일까지 자료를 전달해 주세요.'], ['자료를 금요일까지 보내 주시겠어요?']]);
  await page.goto('/');
  const document = `선택하지 않은 앞 문장.\n${source}\n선택하지 않은 뒤 문장.`;
  await firstCorrection(page, document, source);
  await selectRequirement(page, 'alternative');
  await expect(requirement(page, 'alternative')).toBeChecked();
  expect(calls.corrections).toHaveLength(1);
  expect(calls.explanations).toHaveLength(0);
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText(['자료를 금요일까지 보내 주시겠어요?', '금요일까지 자료를 전달해 주세요.']);
  expect(calls.corrections[1]).toMatchObject({ sourceText: source, targetCandidate: calls.candidates[0][0], retryContext: {
    requirement: 'alternative', previousSourceText: source, previousCandidates: [calls.candidates[0][0]],
  } });
  expect(calls.corrections[1].requestId).not.toBe(calls.corrections[0].requestId);
  await expect(page.getByLabel('원문 입력')).toHaveValue(document);
  expect(calls.explanations).toHaveLength(0);
  await results(page).getByRole('button', { name: /교정 이유/ }).click();
  await expect(results(page).locator('.candidate-explanation p')).toHaveText([explanationText, explanationText]);
  expect(calls.explanations).toHaveLength(2);
  expect(calls.explanations.find(input => input.targetCandidate)).toMatchObject({ sourceText: source, candidates: calls.candidates[1],
    targetCandidate: calls.candidates[0][0], retryContext: calls.corrections[1].retryContext });
  expect(calls.explanations.find(input => !input.targetCandidate)).toMatchObject({ sourceText: source, candidates: [calls.candidates[0][1]] });
  const records = await historyRecords(page);
  expect(records).toHaveLength(2);
  expect(records.find(record => record.id === calls.corrections[1].requestId)).toMatchObject({ parentRecordId: calls.corrections[0].requestId, sourceText: source });
  const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
  expect(events.find(event => event.action === 'correction_requested')).toMatchObject({ parentRequestId: calls.corrections[0].requestId, phase: 'before_apply', requirement: 'alternative' });
  expect(events.filter(event => event.action === 'explanation_requested')).toHaveLength(1);
  expect(events.filter(event => event.action === 'explanation_received')).toHaveLength(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/rerun-desktop.png', fullPage: true });
});

test('after application, rerun corrects the currently applied text and retains the previous request as context', async ({ page }) => {
  const source = '자료 보내 주세여.';
  const applied = '자료를 보내 주세요.';
  const next = '자료를 보내 주시면 감사하겠습니다.';
  const calls = await mockModels(page, [[applied], [next]]);
  await page.goto('/');
  await firstCorrection(page, `앞.\n${source}\n뒤.`, source);
  await results(page).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue(`앞.\n${applied}\n뒤.`);
  await selectRequirement(page, 'polite');
  expect(calls.corrections).toHaveLength(1);
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText(next);
  expect(calls.corrections[1]).toMatchObject({ sourceText: applied, retryContext: {
    requirement: 'polite', previousSourceText: source, previousCandidates: [calls.candidates[0][0]],
  } });
  expect(calls.corrections[1].targetCandidate).toBeUndefined();
  await results(page).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue(`앞.\n${next}\n뒤.`);
  const records = await historyRecords(page);
  expect(records.find(record => record.id === calls.corrections[1].requestId)).toMatchObject({ sourceText: applied,
    parentRecordId: calls.corrections[0].requestId, appliedCandidateId: calls.candidates[1][0].id });
  const events = (await activityRecords(page)).events;
  expect(events.find(event => event.requestId === calls.corrections[1].requestId && event.action === 'correction_requested')).toMatchObject({
    parentRequestId: calls.corrections[0].requestId, phase: 'after_apply', requirement: 'polite',
  });
  expect(events.filter(event => event.action === 'candidate_applied')).toHaveLength(2);
});

test('skipping the optional requirement still targets the chosen candidate without leaking an earlier choice', async ({ page }) => {
  const calls = await mockModels(page, [['첫 후보입니다.'], ['다른 후보입니다.']]);
  await page.goto('/');
  await firstCorrection(page, '원문입니다.');
  await selectRequirement(page, 'meaning');
  await selectRequirement(page, '');
  expect(calls.corrections).toHaveLength(1);
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('다른 후보입니다.');
  expect(Object.keys(calls.corrections[1]).sort()).toEqual(['requestId', 'sourceText', 'targetCandidate']);
  expect(calls.corrections[1].sourceText).toBe('원문입니다.');
  expect(calls.corrections[1].targetCandidate).toEqual(calls.candidates[0][0]);
  const record = (await historyRecords(page)).find(value => value.id === calls.corrections[1].requestId);
  expect(record?.parentRecordId).toBe(calls.corrections[0].requestId);
  const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
  expect(events.find(event => event.action === 'correction_requested')).toMatchObject({ parentRequestId: calls.corrections[0].requestId, phase: 'before_apply' });
  expect(events.every(event => event.requirement === undefined)).toBe(true);
});

test('candidate-local rerun panels share a draft choice until the chosen candidate succeeds and resets it', async ({ page }) => {
  const source = '금요일까지 자료 보내 주세여.';
  const oldCandidates = ['금요일까지 자료를 보내 주세요.', '금요일까지 자료 전달 부탁드립니다.', '자료를 금요일까지 보내 주시겠어요?'];
  const newCandidate = '자료를 금요일까지 보내 주실 수 있을까요?';
  const newCandidates = [...oldCandidates.slice(0, 2), newCandidate];
  const calls = await mockModels(page, [oldCandidates, [newCandidate]]);
  await page.goto('/');
  await firstCorrection(page, source);
  const cards = results(page).locator('.candidate-card');
  await expect(cards).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    const apply = await cards.nth(index).getByRole('button', { name: '이 문장 적용', exact: true }).boundingBox();
    const reopen = await rerunToggle(page, index).boundingBox();
    expect(apply && reopen).toBeTruthy();
    expect(Math.abs(apply!.width - reopen!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(apply!.height - reopen!.height)).toBeLessThanOrEqual(1);
    expect(reopen!.y).toBeGreaterThanOrEqual(apply!.y + apply!.height);
    await expect(rerunToggle(page, index)).toHaveAttribute('aria-expanded', 'false');
  }

  await selectRequirement(page, 'polite');
  await expect(rerunToggle(page, 0)).toHaveAttribute('aria-expanded', 'true');
  await rerunToggle(page, 1).click();
  await expect(rerun(page)).toHaveCount(1);
  await expect(cards.nth(0).getByRole('region', { name: '재교정 요청' })).toHaveCount(0);
  await expect(cards.nth(1).getByRole('region', { name: '재교정 요청' })).toBeVisible();
  await expect(requirement(page, 'polite')).toBeChecked();
  await expect(rerunToggle(page, 0)).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/rerun-inline-desktop.png', fullPage: true });
  await rerunToggle(page, 1).click();
  await expect(rerun(page)).toHaveCount(0);
  await rerunToggle(page, 2).click();
  await expect(requirement(page, 'polite')).toBeChecked();
  expect(calls.corrections).toHaveLength(1);
  expect(calls.explanations).toHaveLength(0);

  await rerunButton(page).click();
  await expect(cards.locator('.candidate-text')).toHaveText(newCandidates);
  await expect(rerun(page)).toHaveCount(0);
  expect(calls.corrections[1].sourceText).toBe(source);
  expect(calls.corrections[1].targetCandidate).toEqual(calls.candidates[0][2]);
  expect(calls.corrections[1].retryContext?.previousCandidates).toEqual([calls.candidates[0][2]]);
  expect(calls.corrections[1].retryContext?.requirement).toBe('polite');
  await rerunToggle(page, 1).click();
  await expect(requirement(page, '')).toBeChecked();
  await expect(requirement(page, 'polite')).not.toBeChecked();
  expect(calls.corrections).toHaveLength(2);

  await results(page).getByRole('button', { name: /교정 이유/ }).click();
  await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
  expect(calls.explanations.find(input => input.targetCandidate)?.retryContext?.requirement).toBe('polite');
  expect(calls.explanations).toHaveLength(2);
  expect((await activityRecords(page)).events.find(event => event.requestId === calls.corrections[1].requestId && event.action === 'correction_received')?.requirement).toBe('polite');
});

test('revising different cards keeps their independent origin links and applying an untouched sibling records its original request', async ({ page }) => {
  const source = '자료를 보내 주세여.';
  const initial = ['자료를 보내 주세요.', '자료를 전달해 주세요.', '자료를 보내 주시기 바랍니다.'];
  const calls = await mockModels(page, [initial, ['자료를 보내 주세요. 감사합니다.'], ['자료 전달 부탁드립니다.'], ['자료를 보내 주실 수 있나요?']]);
  await page.goto('/');
  await firstCorrection(page, source);
  await rerunToggle(page, 2).click();
  await selectRequirement(page, 'plain');
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText([initial[0], initial[1], '자료를 보내 주세요. 감사합니다.']);
  await rerunToggle(page, 0).click();
  await selectRequirement(page, 'alternative');
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText(['자료 전달 부탁드립니다.', initial[1], '자료를 보내 주세요. 감사합니다.']);
  await rerunToggle(page, 2).click();
  await selectRequirement(page, 'polite');
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText(['자료 전달 부탁드립니다.', initial[1], '자료를 보내 주실 수 있나요?']);
  expect(calls.corrections[1].targetCandidate).toEqual(calls.candidates[0][2]);
  expect(calls.corrections[2].targetCandidate).toEqual(calls.candidates[0][0]);
  expect(calls.corrections[3].targetCandidate).toEqual(calls.candidates[1][0]);
  expect(calls.corrections.slice(1).every(input => input.sourceText === source)).toBe(true);
  let records = await historyRecords(page);
  expect(records).toHaveLength(4);
  for (const [index, parent] of [[1, 0], [2, 0], [3, 1]]) {
    expect(records.find(record => record.id === calls.corrections[index].requestId)).toMatchObject({
      parentRecordId: calls.corrections[parent].requestId, candidates: calls.candidates[index],
    });
  }
  await results(page).locator('.candidate-card').nth(1).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(page.getByLabel('원문 입력')).toHaveValue(initial[1]);
  records = await historyRecords(page);
  expect(records.find(record => record.id === calls.corrections[0].requestId)?.appliedCandidateId).toBe(calls.candidates[0][1].id);
  expect(records.filter(record => record.id !== calls.corrections[0].requestId).every(record => record.appliedCandidateId === null)).toBe(true);
  expect((await activityRecords(page)).events.find(event => event.action === 'candidate_applied')).toMatchObject({
    requestId: calls.corrections[0].requestId, candidateId: calls.candidates[0][1].id,
  });
});

test('an open target comparison and cached sibling explanations survive revision while the new reason loads automatically once', async ({ page }) => {
  const correctionRequested = gate();
  const releaseCorrection = gate();
  const explanationRequested = gate();
  const releaseExplanation = gate();
  const initial = ['첫 번째 후보.', '두 번째 후보.', '세 번째 후보.'];
  const source = '원래 선택한 문장.';
  const revised = '세 번째 후보를 더 담백하게 다듬었습니다.';
  const calls = await mockModels(page, [initial, [revised]], async (_input, index) => {
    if (index === 1) { correctionRequested.resolve(); await releaseCorrection.promise; }
  }, async (_input, index) => {
    if (index === 1) { explanationRequested.resolve(); await releaseExplanation.promise; }
  });
  await page.goto('/');
  await firstCorrection(page, source);
  const cards = results(page).locator('.candidate-card');
  await results(page).getByRole('button', { name: '교정 이유', exact: true }).click();
  await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
  await cards.first().locator('summary').click();
  await cards.nth(2).locator('summary').click();
  await rerunToggle(page, 2).click();
  await selectRequirement(page, 'plain');
  await rerunButton(page).click();
  await correctionRequested.promise;
  try {
    await expect(cards.locator('.candidate-text')).toHaveText(initial);
    await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
    await expect(cards.nth(2).locator('details')).toHaveAttribute('open', '');
  } finally { releaseCorrection.resolve(); }
  await explanationRequested.promise;
  try {
    await expect(cards.locator('.candidate-text')).toHaveText([...initial.slice(0, 2), revised]);
    await expect(cards.first().locator('details')).toHaveAttribute('open', '');
    await expect(cards.nth(1).locator('details')).not.toHaveAttribute('open', '');
    await expect(cards.nth(2).locator('details')).toHaveAttribute('open', '');
    await expect(cards.nth(2).locator('.comparison-content > p')).toHaveText([source, revised]);
    await expect(cards.nth(2).getByText('새 교정 이유를 생성하고 있습니다.', { exact: true })).toBeVisible();
    await expect(cards.nth(2).getByText(explanationText, { exact: true })).toHaveCount(0);
    for (const index of [0, 1]) await expect(cards.nth(index).locator('.candidate-explanation p')).toHaveText(explanationText);
    await expect(rerun(page)).toHaveCount(0);
    await expect(results(page).getByRole('button', { name: '새 후보 설명 보기', exact: true })).toHaveCount(0);
    expect(calls.explanations).toHaveLength(2);
  } finally { releaseExplanation.resolve(); }
  await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
  expect(calls.explanations).toHaveLength(2);
  await expect(rerunToggle(page, 2)).toBeFocused();
  expect(calls.explanations[1]).toMatchObject({ sourceText: source, candidates: calls.candidates[1], targetCandidate: calls.candidates[0][2],
    retryContext: calls.corrections[1].retryContext });
  const records = await historyRecords(page);
  expect(records.find(record => record.id === calls.corrections[0].requestId)?.explanations).toHaveLength(3);
  expect(records.find(record => record.id === calls.corrections[1].requestId)?.explanations).toEqual([
    { candidateId: calls.candidates[1][0].id, explanation: explanationText },
  ]);
  const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
  expect(events.filter(event => event.action === 'explanation_requested')).toHaveLength(1);
  expect(events.filter(event => event.action === 'explanation_received')).toHaveLength(1);
});

test('a late explanation for the previous batch fills unchanged siblings without attaching the old explanation to a revised candidate', async ({ page }) => {
  const requested = gate();
  const release = gate();
  const nextRequested = gate();
  const releaseNext = gate();
  const calls = await mockModels(page, [['첫 번째 후보.', '두 번째 후보.', '세 번째 후보.'], ['새 세 번째 후보.']]);
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    calls.explanations.push(input);
    if (calls.explanations.length === 1) { requested.resolve(); await release.promise; }
    else { nextRequested.resolve(); await releaseNext.promise; }
    await route.fulfill({ json: { ...input, explanations: input.candidates.map(candidate => ({ candidateId: candidate.id,
      explanation: input.targetCandidate ? '새 후보에 맞는 설명입니다.' : '이전 후보에 맞는 설명입니다.' })) } });
  });
  await page.goto('/');
  await firstCorrection(page, '원래 선택한 문장.');
  await results(page).getByRole('button', { name: '교정 이유', exact: true }).click();
  await requested.promise;
  await rerunToggle(page, 2).click();
  await selectRequirement(page, 'polite');
  await rerunButton(page).click();
  try {
    await expect(results(page).locator('.candidate-text')).toHaveText(['첫 번째 후보.', '두 번째 후보.', '새 세 번째 후보.']);
  } finally { release.resolve(); }
  await nextRequested.promise;
  try {
    for (const index of [0, 1]) await expect(results(page).locator('.candidate-card').nth(index).locator('.candidate-explanation p')).toHaveText('이전 후보에 맞는 설명입니다.');
    await expect(results(page).locator('.candidate-card').nth(2).getByText('이전 후보에 맞는 설명입니다.', { exact: true })).toHaveCount(0);
    await expect(results(page).locator('.candidate-card').nth(2).getByText('새 교정 이유를 생성하고 있습니다.', { exact: true })).toBeVisible();
    const records = await historyRecords(page);
    expect(records.find(record => record.id === calls.corrections[0].requestId)?.explanations).toHaveLength(3);
    expect(records.find(record => record.id === calls.corrections[1].requestId)?.explanations).toHaveLength(0);
  } finally { releaseNext.resolve(); }
  await expect(results(page).locator('.candidate-card').nth(2).locator('.candidate-explanation')).toContainText('새 후보에 맞는 설명입니다.');
  expect(calls.explanations).toHaveLength(2);
  expect(calls.explanations[1].candidates).toEqual(calls.candidates[1]);
  const records = await historyRecords(page);
  expect(records.find(record => record.id === calls.corrections[1].requestId)?.explanations).toEqual([
    { candidateId: calls.candidates[1][0].id, explanation: '새 후보에 맞는 설명입니다.' },
  ]);
});

for (const closeAt of ['before rerun', 'during rerun'] as const) {
  test(`closing explanations ${closeAt} leaves a closed comparison closed and requests only the missing reason when reopened`, async ({ page }) => {
    const requested = gate();
    const release = gate();
    const initial = ['첫 번째 후보.', '두 번째 후보.', '세 번째 후보.'];
    const calls = await mockModels(page, [initial, ['새 두 번째 후보.']], async (_input, index) => {
      if (index === 1) { requested.resolve(); await release.promise; }
    });
    await page.goto('/');
    await firstCorrection(page, '원래 선택한 문장.');
    const cards = results(page).locator('.candidate-card');
    const explanationToggle = results(page).getByRole('button', { name: '교정 이유', exact: true });
    await explanationToggle.click();
    await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
    await cards.first().locator('summary').click();
    if (closeAt === 'before rerun') await explanationToggle.click();
    await rerunToggle(page, 1).click();
    await selectRequirement(page, 'plain');
    await rerunButton(page).click();
    await requested.promise;
    try {
      if (closeAt === 'during rerun') await explanationToggle.click();
      await expect(explanationToggle).toHaveAttribute('aria-expanded', 'false');
    } finally { release.resolve(); }
    await expect(cards.locator('.candidate-text')).toHaveText([initial[0], '새 두 번째 후보.', initial[2]]);
    await expect(cards.first().locator('details')).toHaveAttribute('open', '');
    await expect(cards.nth(1).locator('details')).not.toHaveAttribute('open', '');
    await expect(cards.nth(2).locator('details')).not.toHaveAttribute('open', '');
    await expect(cards.locator('.candidate-explanation')).toHaveCount(0);
    expect(calls.explanations).toHaveLength(1);
    await explanationToggle.click();
    await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
    expect(calls.explanations).toHaveLength(2);
    expect(calls.explanations[1]).toMatchObject({ candidates: calls.candidates[1], targetCandidate: calls.candidates[0][1] });
    await explanationToggle.click();
    await explanationToggle.click();
    await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
    expect(calls.explanations).toHaveLength(2);
  });
}

test('a failed automatic reason request leaves siblings intact and retries only the missing candidate on explicit retry', async ({ page }) => {
  const initial = ['첫 번째 후보.', '두 번째 후보.', '세 번째 후보.'];
  const calls = await mockModels(page, [initial, ['더 담백한 첫 번째 후보.']]);
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    calls.explanations.push(input);
    if (calls.explanations.length === 2) {
      await route.fulfill({ status: 503, json: { requestId: input.requestId,
        error: { code: 'MODEL_UNAVAILABLE', message: '새 설명을 불러오지 못했습니다.', retryable: true } } });
    } else {
      await route.fulfill({ json: { ...input, explanations: input.candidates.map(candidate => ({ candidateId: candidate.id,
        explanation: input.targetCandidate ? '새 후보의 설명을 다시 받았습니다.' : explanationText })) } });
    }
  });
  await page.goto('/');
  await firstCorrection(page, '원래 선택한 문장.');
  const cards = results(page).locator('.candidate-card');
  const explanationToggle = results(page).getByRole('button', { name: '교정 이유', exact: true });
  await explanationToggle.click();
  await expect(cards.locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
  await cards.first().locator('summary').click();
  await selectRequirement(page, 'plain');
  await rerunButton(page).click();
  await expect(cards.locator('.candidate-text')).toHaveText(['더 담백한 첫 번째 후보.', ...initial.slice(1)]);
  const retry = results(page).getByRole('button', { name: '설명 다시 시도', exact: true });
  await expect(retry).toBeEnabled();
  await expect(cards.first().locator('details')).toHaveAttribute('open', '');
  for (const index of [1, 2]) await expect(cards.nth(index).locator('.candidate-explanation p')).toHaveText(explanationText);
  await expect(cards.first().getByText(explanationText, { exact: true })).toHaveCount(0);
  // Reopening an already failed request must not silently spend another call.
  await explanationToggle.click();
  await explanationToggle.click();
  await expect(retry).toBeEnabled();
  expect(calls.explanations).toHaveLength(2);
  await retry.click();
  await expect(cards.first().locator('.candidate-explanation p')).toHaveText('새 후보의 설명을 다시 받았습니다.');
  expect(calls.explanations).toHaveLength(3);
  expect(calls.explanations[2]).toMatchObject({ sourceText: calls.explanations[1].sourceText,
    candidates: calls.candidates[1], targetCandidate: calls.candidates[0][0], retryContext: calls.corrections[1].retryContext });
  const records = await historyRecords(page);
  expect(records.find(record => record.id === calls.corrections[1].requestId)?.explanations).toEqual([
    { candidateId: calls.candidates[1][0].id, explanation: '새 후보의 설명을 다시 받았습니다.' },
  ]);
  const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
  expect(events.filter(event => event.action === 'explanation_requested')).toHaveLength(2);
  expect(events.filter(event => event.action === 'explanation_failed')).toHaveLength(1);
  expect(events.filter(event => event.action === 'explanation_received')).toHaveLength(1);
});

for (const invalid of ['wrong target', 'three results'] as const) {
  test(`a targeted response containing ${invalid} preserves the current cards and is not saved as success`, async ({ page }) => {
    const initial = ['첫 번째 후보.', '두 번째 후보.', '세 번째 후보.'];
    const calls = await mockModels(page, [initial]);
    await page.goto('/');
    await firstCorrection(page, '대상 후보를 확인할 원문.');
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON() as CorrectionInput;
      calls.corrections.push(input);
      await route.fulfill({ json: { ...input,
        ...(invalid === 'wrong target' ? { targetCandidate: calls.candidates[0][0] } : {}),
        candidates: invalid === 'three results'
          ? [0, 1, 2].map(index => ({ id: `invalid-${index}`, text: `잘못 받은 후보 ${index}` }))
          : [{ id: 'wrong-target-result', text: '다른 대상의 후보.' }],
      } });
    });
    await rerunToggle(page, 2).click();
    await selectRequirement(page, 'plain');
    await rerunButton(page).click();
    await expect(rerun(page).getByRole('alert')).toBeVisible();
    await expect(results(page).locator('.candidate-text')).toHaveText(initial);
    await expect(requirement(page, 'plain')).toBeChecked();
    expect(await historyRecords(page)).toHaveLength(1);
    const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
    expect(events.filter(event => event.action === 'correction_failed')).toHaveLength(1);
    expect(events.some(event => event.action === 'correction_received')).toBe(false);
  });
}

const varyingCandidates = (label: string, lineCounts: number[]) => lineCounts.map((lineCount, index) =>
  Array.from({ length: lineCount }, (_, line) => `${label} 후보 ${index + 1}: 확인할 안내 ${line + 1}을 전달합니다.`).join('\n'));

async function settleLayout(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const scenario of [
  { label: 'desktop candidate 2', index: 1, width: 1280, height: 900 },
  { label: 'desktop candidate 3', index: 2, width: 1280, height: 900 },
  { label: 'mobile candidate 3', index: 2, width: 390, height: 844 },
]) {
  test(`a rerun restores focus and viewport position to ${scenario.label} when its candidate length changes`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    const requested = gate();
    const release = gate();
    const oldCandidates = varyingCandidates('기존', [8, 12, 16]);
    const newCandidate = varyingCandidates('새로운', [14, 4, 6])[scenario.index];
    const newCandidates = oldCandidates.map((text, index) => index === scenario.index ? newCandidate : text);
    const calls = await mockModels(page, [oldCandidates, [newCandidate]], async (_input, index) => {
      if (index === 1) { requested.resolve(); await release.promise; }
    });
    await page.goto('/');
    await firstCorrection(page, '금요일까지 자료를 전달해 주세요.');
    await rerunToggle(page, scenario.index).click();
    await selectRequirement(page, 'polite');
    await rerunToggle(page, scenario.index).evaluate(button => {
      window.scrollTo(0, window.scrollY + button.getBoundingClientRect().top - 100);
    });
    await expect(rerunButton(page)).toBeInViewport({ ratio: 1 });
    await rerunButton(page).focus();
    await rerunButton(page).press('Enter');
    await requested.promise;
    let previousTop = 0;
    try {
      await settleLayout(page);
      await expect(rerunToggle(page, scenario.index)).toBeInViewport({ ratio: 1 });
      previousTop = (await rerunToggle(page, scenario.index).boundingBox())!.y;
    } finally { release.resolve(); }
    await expect(results(page).locator('.candidate-text')).toHaveText(newCandidates);
    await expect(rerun(page)).toHaveCount(0);
    await expect(rerunToggle(page, scenario.index)).toBeFocused();
    await expect(rerunToggle(page, scenario.index)).toBeInViewport({ ratio: 1 });
    await settleLayout(page);
    expect(Math.abs((await rerunToggle(page, scenario.index).boundingBox())!.y - previousTop)).toBeLessThanOrEqual(24);
    expect(calls.corrections).toHaveLength(2);
    expect(calls.corrections[1].retryContext?.requirement).toBe('polite');
    await rerunToggle(page, scenario.index).press('Enter');
    await expect(requirement(page, '')).toBeChecked();
    expect(calls.corrections).toHaveLength(2);
  });
}

test('a mobile rerun keeps candidate 3 reachable when only its submit button was visible before the response', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requested = gate();
  const release = gate();
  const oldCandidates = varyingCandidates('기존', [8, 12, 16]);
  const newCandidate = varyingCandidates('새로운', [14, 4, 6])[2];
  const newCandidates = [...oldCandidates.slice(0, 2), newCandidate];
  const calls = await mockModels(page, [oldCandidates, [newCandidate]], async (_input, index) => {
    if (index === 1) { requested.resolve(); await release.promise; }
  });
  await page.goto('/');
  await firstCorrection(page, '금요일까지 자료를 전달해 주세요.');
  await rerunToggle(page, 2).click();
  await selectRequirement(page, 'alternative');
  await rerunButton(page).click();
  await requested.promise;
  try {
    await rerunButton(page).evaluate(button => {
      window.scrollTo(0, window.scrollY + button.getBoundingClientRect().top - 220);
    });
    await settleLayout(page);
    await expect(rerunButton(page)).toBeInViewport({ ratio: 1 });
    const previousToggle = await rerunToggle(page, 2).boundingBox();
    expect(previousToggle!.y + previousToggle!.height).toBeLessThanOrEqual(0);
  } finally { release.resolve(); }
  await expect(results(page).locator('.candidate-text')).toHaveText(newCandidates);
  await expect(rerun(page)).toHaveCount(0);
  await expect(rerunToggle(page, 2)).toBeFocused();
  await expect(rerunToggle(page, 2)).toBeInViewport({ ratio: 1 });
  expect(calls.corrections).toHaveLength(2);
});

for (const destination of ['history button', 'editor', 'history view'] as const) {
  test(`a completed rerun does not steal focus after the user moves to the ${destination}`, async ({ page }) => {
    const requested = gate();
    const release = gate();
    const oldCandidates = varyingCandidates('기존', [8, 6, 10]);
    const newCandidate = varyingCandidates('새로운', [6, 3, 8])[2];
    const newCandidates = [...oldCandidates.slice(0, 2), newCandidate];
    const calls = await mockModels(page, [oldCandidates, [newCandidate]], async (_input, index) => {
      if (index === 1) { requested.resolve(); await release.promise; }
    });
    await page.goto('/');
    await firstCorrection(page, '금요일까지 자료를 전달해 주세요.');
    await rerunToggle(page, 2).click();
    await rerunButton(page).click();
    await requested.promise;
    let destinationControl: Locator;
    try {
      if (destination === 'history view') {
        await page.getByRole('button', { name: '교정 이력', exact: true }).click();
        await expect(history(page)).toBeVisible();
        destinationControl = history(page).getByRole('button', { name: '교정 문장으로 돌아가기', exact: true });
      } else {
        destinationControl = destination === 'editor' ? page.getByLabel('원문 입력') : page.getByRole('button', { name: '교정 이력', exact: true });
      }
      await destinationControl.focus();
      await expect(destinationControl).toBeFocused();
    } finally { release.resolve(); }
    await expect(results(page).locator('.candidate-text')).toHaveText(newCandidates);
    await settleLayout(page);
    await expect(destinationControl!).toBeFocused();
    if (destination === 'history view') {
      await expect(history(page)).toBeVisible();
      await expect(results(page)).toBeHidden();
    } else {
      await expect(history(page)).toBeHidden();
    }
    expect(calls.corrections).toHaveLength(2);
    expect(calls.explanations).toHaveLength(0);
  });
}

for (const destination of ['editor', 'history view'] as const) {
  test(`a failed rerun does not steal focus after the user moves to the ${destination}`, async ({ page }) => {
    const requested = gate();
    const release = gate();
    const initial = ['첫 번째 후보.', '두 번째 후보.', '세 번째 후보.'];
    const calls = await mockModels(page, [initial, 'failure'], async (_input, index) => {
      if (index === 1) { requested.resolve(); await release.promise; }
    });
    await page.goto('/');
    await firstCorrection(page, '금요일까지 자료를 전달해 주세요.');
    await rerunToggle(page, 2).click();
    await selectRequirement(page, 'plain');
    await rerunButton(page).click();
    await requested.promise;
    let destinationControl: Locator;
    try {
      if (destination === 'history view') {
        await page.getByRole('button', { name: '교정 이력', exact: true }).click();
        destinationControl = history(page).getByRole('button', { name: '교정 문장으로 돌아가기', exact: true });
      } else destinationControl = page.getByLabel('원문 입력');
      await destinationControl.focus();
      await expect(destinationControl).toBeFocused();
    } finally { release.resolve(); }
    await expect(results(page).locator('.rerun-submit-row button')).toHaveText('다시 시도');
    await settleLayout(page);
    await expect(destinationControl!).toBeFocused();
    await expect(results(page).locator('.candidate-text')).toHaveText(initial);
    if (destination === 'history view') {
      await expect(history(page)).toBeVisible();
      await expect(results(page)).toBeHidden();
    }
    expect(calls.corrections).toHaveLength(2);
  });
}

test('pending and repeated failed reruns retain all candidates and explanations without duplicate requests or a false success', async ({ page }) => {
  const requested = gate();
  const release = gate();
  const oldCandidates = ['첫 번째 기존 후보.', '두 번째 기존 후보.', '세 번째 기존 후보.'];
  const newCandidate = '두 번째 새 후보.';
  const newCandidates = [oldCandidates[0], newCandidate, oldCandidates[2]];
  const calls = await mockModels(page, [oldCandidates, 'failure', 'failure', [newCandidate]], async (_input, index) => {
    if (index === 1) { requested.resolve(); await release.promise; }
  });
  await page.goto('/');
  await firstCorrection(page, '원래 선택한 문장.');
  await results(page).getByRole('button', { name: /교정 이유/ }).click();
  await expect(results(page).locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
  await results(page).locator('.candidate-card').first().locator('summary').click();
  await results(page).locator('.candidate-card').nth(1).locator('summary').click();
  await rerunToggle(page, 1).click();
  await selectRequirement(page, 'errors');
  await rerunButton(page).click();
  await requested.promise;
  try {
    await expect(results(page).locator('.candidate-text')).toHaveText(oldCandidates);
    await expect(results(page).locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
    await expect(results(page).locator('.candidate-explanation').first()).toBeVisible();
    await expect(results(page).locator('.candidate-card').first().locator('details')).toHaveAttribute('open', '');
    await expect(results(page).locator('.candidate-card').nth(1).locator('details')).toHaveAttribute('open', '');
    const cachedExplanationToggle = results(page).getByRole('button', { name: '교정 이유', exact: true });
    await expect(cachedExplanationToggle).toBeEnabled();
    await cachedExplanationToggle.click();
    await expect(results(page).locator('.candidate-explanation')).toHaveCount(0);
    await cachedExplanationToggle.click();
    await expect(results(page).locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
    expect(calls.explanations).toHaveLength(1);
    await expect(rerunButton(page)).toBeDisabled();
    for (let index = 0; index < 3; index++) {
      await expect(results(page).getByRole('button', { name: '이 문장 적용', exact: true }).nth(index)).toBeDisabled();
      await expect(rerunToggle(page, index)).toBeDisabled();
      await expect(results(page).locator('.candidate-card').nth(index)).toBeVisible();
    }
    await expect(requirement(page, 'errors')).toBeDisabled();
    // Even a programmatic native click on disabled controls must not start another request or apply stale text.
    await rerunButton(page).evaluate((button: HTMLButtonElement) => button.click());
    await results(page).getByRole('button', { name: '이 문장 적용', exact: true }).first().evaluate((button: HTMLButtonElement) => button.click());
    expect(calls.corrections).toHaveLength(2);
    await expect(page.getByLabel('원문 입력')).toHaveValue('원래 선택한 문장.');
  } finally { release.resolve(); }

  for (let failureIndex = 1; failureIndex <= 2; failureIndex++) {
    await expect(rerunButton(page)).toHaveText('다시 시도');
    await expect(rerunButton(page)).toBeEnabled();
    await expect(results(page).locator('.candidate-text')).toHaveText(oldCandidates);
    await expect(results(page).locator('.candidate-explanation')).toHaveCount(3);
    await expect(results(page).locator('.candidate-card').first().locator('details')).toHaveAttribute('open', '');
    await expect(results(page).locator('.candidate-card').nth(1).locator('details')).toHaveAttribute('open', '');
    await expect(requirement(page, 'errors')).toBeChecked();
    await expect(results(page).locator('.candidate-card').nth(1).getByRole('region', { name: '재교정 요청' })).toBeVisible();
    expect(calls.corrections).toHaveLength(failureIndex + 1);
    const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[failureIndex].requestId);
    expect(events.filter(event => event.action === 'correction_failed')).toHaveLength(1);
    expect(events.some(event => event.action === 'correction_received')).toBe(false);
    await expect(history(page).locator('.history-entry')).toHaveCount(1);
    await rerunButton(page).click();
  }
  await expect(results(page).locator('.candidate-text')).toHaveText(newCandidates);
  await expect(rerun(page)).toHaveCount(0);
  await expect(results(page).locator('.candidate-card').first().locator('details')).toHaveAttribute('open', '');
  await expect(results(page).locator('.candidate-card').nth(1).locator('details')).toHaveAttribute('open', '');
  await expect(results(page).locator('.candidate-explanation p')).toHaveText(Array(3).fill(explanationText));
  expect(calls.explanations).toHaveLength(2);
  const records = await historyRecords(page);
  expect(records).toHaveLength(2);
  expect(records.find(record => record.id === calls.corrections[3].requestId)?.parentRecordId).toBe(calls.corrections[0].requestId);
  for (const input of calls.corrections.slice(1)) expect(input.retryContext).toEqual(calls.corrections[1].retryContext);
});

test('an applied sentence and its rerun notice survive a failed request and remain the retry source', async ({ page }) => {
  const requested = gate();
  const release = gate();
  const source = '자료 보내 주세여.';
  const applied = '자료를 보내 주세요.';
  const newCandidates = ['자료를 보내 주시기 바랍니다.', '자료 전달을 부탁드립니다.', '자료를 보내 주시면 감사하겠습니다.'];
  const calls = await mockModels(page, [[applied, '자료 전달 부탁드려요.', '자료를 보내 주시겠어요?'], 'failure', newCandidates], async (_input, index) => {
    if (index === 1) { requested.resolve(); await release.promise; }
  });
  await page.goto('/');
  await firstCorrection(page, `앞.\n${source}\n뒤.`, source);
  await results(page).getByRole('button', { name: '이 문장 적용', exact: true }).first().click();
  const appliedNotice = results(page).getByText('선택한 문장에 적용했습니다.', { exact: true });
  await expect(appliedNotice).toBeVisible();
  await selectRequirement(page, 'polite');
  await rerunButton(page).click();
  await requested.promise;
  try {
    await expect(appliedNotice).toBeVisible();
    await expect(page.getByLabel('원문 입력')).toHaveValue(`앞.\n${applied}\n뒤.`);
    await expect(rerunToggle(page)).toBeDisabled();
    await expect(rerunButton(page)).toBeDisabled();
  } finally { release.resolve(); }
  await expect(rerunButton(page)).toHaveText('다시 시도');
  await expect(appliedNotice).toBeVisible();
  await expect(requirement(page, 'polite')).toBeChecked();
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText(newCandidates);
  expect(calls.corrections[1].sourceText).toBe(applied);
  expect(calls.corrections[2].sourceText).toBe(applied);
  expect(calls.corrections[2].retryContext).toEqual(calls.corrections[1].retryContext);
  const records = await historyRecords(page);
  expect(records.find(record => record.id === calls.corrections[0].requestId)?.appliedCandidateId).toBe(calls.candidates[0][0].id);
  expect(records.find(record => record.id === calls.corrections[2].requestId)?.parentRecordId).toBe(calls.corrections[0].requestId);
});

for (const change of ['edit', 'selection'] as const) {
  test(`${change} invalidates the previous rerun context and the next ordinary request has no requirement or parent`, async ({ page }) => {
    const calls = await mockModels(page, [['첫 줄의 후보.'], ['새 요청 후보.']]);
    await page.goto('/');
    const document = '첫째 문장.\n둘째 문장.';
    await firstCorrection(page, document, '첫째 문장.');
    await selectRequirement(page, 'plain');
    const nextSource = change === 'edit' ? '직접 고친 원문.' : '둘째 문장.';
    if (change === 'edit') {
      await page.getByLabel('원문 입력').fill(nextSource);
      await selectRange(page, 0, nextSource.length);
    } else {
      const start = document.indexOf(nextSource);
      await selectRange(page, start, start + nextSource.length);
    }
    await expect(rerun(page)).toHaveCount(0);
    expect(calls.corrections).toHaveLength(1);
    await startCorrection(page);
    await expect(results(page).locator('.candidate-text')).toHaveText('새 요청 후보.');
    expect(calls.corrections[1].sourceText).toBe(nextSource);
    expect(calls.corrections[1].retryContext).toBeUndefined();
    expect((await historyRecords(page)).find(record => record.id === calls.corrections[1].requestId)?.parentRecordId).toBeUndefined();
  });
}

test('a failed rerun retains its original context for retry and stores only a safe failure code', async ({ page }) => {
  const calls = await mockModels(page, [['처음 받은 후보.'], 'failure', ['다시 받은 후보.']]);
  await page.goto('/');
  await firstCorrection(page, '오류가 있는 원문.');
  await selectRequirement(page, 'errors');
  await rerunButton(page).click();
  await expect(rerun(page).getByRole('alert')).toContainText(failureText);
  await expect(rerunButton(page)).toBeEnabled();
  await expect(rerunButton(page)).toHaveText('다시 시도');
  await expect(requirement(page, 'errors')).toBeChecked();
  await expect(results(page).locator('.candidate-text')).toHaveText('처음 받은 후보.');
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('다시 받은 후보.');
  expect(calls.corrections[2].sourceText).toBe(calls.corrections[1].sourceText);
  expect(calls.corrections[2].retryContext).toEqual(calls.corrections[1].retryContext);
  const records = await historyRecords(page);
  expect(records).toHaveLength(2);
  expect(records.some(record => record.id === calls.corrections[1].requestId)).toBe(false);
  expect(records.find(record => record.id === calls.corrections[2].requestId)?.parentRecordId).toBe(calls.corrections[0].requestId);
  const exported = await activityRecords(page);
  expect(exported.events.find(event => event.requestId === calls.corrections[1].requestId && event.action === 'correction_failed')).toMatchObject({ errorCode: 'MODEL_UNAVAILABLE' });
  expect(JSON.stringify(exported)).not.toContain(failureText);
});

test('editing during a rerun discards the late result without adding history or recording a received result', async ({ page }) => {
  const requested = gate();
  const release = gate();
  const calls = await mockModels(page, [['기존 후보.'], ['늦은 재교정 후보.']], async (_input, index) => {
    if (index === 1) { requested.resolve(); await release.promise; }
  });
  await page.goto('/');
  await firstCorrection(page, '처음 입력한 원문.');
  await selectRequirement(page, 'alternative');
  await rerunButton(page).click();
  await requested.promise;
  const uncachedExplanationToggle = results(page).getByRole('button', { name: '교정 이유', exact: true });
  await expect(uncachedExplanationToggle).toBeDisabled();
  await uncachedExplanationToggle.evaluate((button: HTMLButtonElement) => button.click());
  expect(calls.explanations).toHaveLength(0);
  await page.getByLabel('원문 입력').fill('기다리다가 바꾼 원문.');
  await expect(rerun(page)).toHaveCount(0);
  release.resolve();
  await expect(results(page).locator('.candidate-card')).toHaveCount(0);
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  const events = (await activityRecords(page)).events.filter(event => event.requestId === calls.corrections[1].requestId);
  expect(events.filter(event => event.action === 'correction_cancelled')).toHaveLength(1);
  expect(events.some(event => event.action === 'correction_received')).toBe(false);
  await page.reload();
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
});

test('a rerun response with a different requirement echo is rejected instead of being saved under the requested choice', async ({ page }) => {
  const calls = await mockModels(page, [['기존 후보.']]);
  await page.goto('/');
  await firstCorrection(page, '요구를 확인할 원문.');
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON() as CorrectionInput;
    calls.corrections.push(input);
    await route.fulfill({ json: { ...input, retryContext: { ...input.retryContext, requirement: 'plain' },
      candidates: [{ id: 'wrong-echo', text: '요구가 잘못 연결된 후보.' }] } });
  });
  await selectRequirement(page, 'polite');
  await rerunButton(page).click();
  await expect(rerun(page).getByRole('alert')).toBeVisible();
  await expect(results(page).locator('.candidate-text')).toHaveText('기존 후보.');
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  expect((await historyRecords(page)).some(record => record.id === calls.corrections[1].requestId)).toBe(false);
});

test('activity JSON/CSV omit all text by default and opt-in content joins only history that still exists', async ({ page }) => {
  const source = '비공개 예시 원문, 첫 줄.\n둘째 줄을 확인해 주세여.';
  const first = '비공개 예시 후보, 첫 줄.\n둘째 줄을 확인해 주세요.';
  const second = '비공개 예시 재교정 후보,\n둘째 줄도 확인 부탁드립니다.';
  const calls = await mockModels(page, [[first], [second]]);
  await page.goto('/');
  await firstCorrection(page, source);
  await results(page).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await selectRequirement(page, 'polite');
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText(second);
  await results(page).getByRole('button', { name: /교정 이유/ }).click();
  await expect(results(page).locator('.candidate-explanation')).toContainText(explanationText);
  await expect(activity(page).getByRole('checkbox', { name: '문장 내용 포함' })).not.toBeChecked();
  const defaultJsonText = await downloadText(page, activity(page), '행동 JSON 내보내기');
  const defaultCsv = await downloadText(page, activity(page), '행동 CSV 내보내기');
  const defaultJson = JSON.parse(defaultJsonText) as ExportedActivity;
  expect(defaultJson.contentIncluded).toBe(false);
  expect(defaultJson.events.length).toBeGreaterThan(0);
  expect(defaultJson.events.every(event => !('content' in event))).toBe(true);
  for (const text of [source, first, second, explanationText]) {
    expect(defaultJsonText).not.toContain(JSON.stringify(text).slice(1, -1));
    expect(defaultCsv).not.toContain(text);
  }
  const defaultRows = parseCsv(defaultCsv);
  expect(defaultRows).toHaveLength(defaultJson.events.length);
  expect(defaultRows.every(row => !('sourceText' in row) && !('candidates' in row) && !('explanations' in row))).toBe(true);
  await activity(page).getByRole('checkbox', { name: '문장 내용 포함' }).check();
  const withContent = await activityRecords(page);
  expect(withContent.contentIncluded).toBe(true);
  expect(withContent.events.find(event => event.requestId === calls.corrections[0].requestId)?.content?.sourceText).toBe(source);
  expect(withContent.events.find(event => event.requestId === calls.corrections[1].requestId)?.content).toMatchObject({ sourceText: first,
    candidates: calls.candidates[1], explanations: [{ candidateId: calls.candidates[1][0].id, explanation: explanationText }] });
  const withContentRows = parseCsv(await downloadText(page, activity(page), '행동 CSV 내보내기'));
  expect(withContentRows.find(row => row.requestId === calls.corrections[1].requestId)?.sourceText).toBe(first);
  expect(JSON.parse(withContentRows.find(row => row.requestId === calls.corrections[1].requestId)!.candidates)).toEqual(calls.candidates[1]);
  await page.getByRole('button', { name: '교정 이력', exact: true }).click();
  const oldRecord = history(page).locator('.history-entry').filter({ has: page.locator('.history-preview', { hasText: '비공개 예시 원문' }) });
  await oldRecord.locator(':scope > summary').click();
  page.once('dialog', dialog => dialog.accept());
  await oldRecord.getByRole('button', { name: '이 기록 삭제' }).click();
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  const afterDelete = await activityRecords(page);
  expect(afterDelete.events.map(event => event.id)).toEqual(withContent.events.map(event => event.id));
  expect(afterDelete.events.filter(event => event.requestId === calls.corrections[0].requestId).every(event => !event.content)).toBe(true);
  expect(afterDelete.events.filter(event => event.requestId === calls.corrections[1].requestId).every(event => event.content?.sourceText === first)).toBe(true);
});

test('participant edits affect future events only after apply and deleting activity leaves correction history intact', async ({ page }) => {
  const calls = await mockModels(page, [['첫 후보.'], ['둘째 후보.'], ['셋째 후보.']]);
  await page.goto('/');
  await activity(page).getByLabel('참여자 코드', { exact: true }).fill('T01');
  await activity(page).getByRole('button', { name: '참여자 코드 적용' }).click();
  await firstCorrection(page, '참여자 검증 원문.');
  await activity(page).getByLabel('참여자 코드', { exact: true }).fill('T02');
  await runRerun(page);
  await expect(results(page).locator('.candidate-text')).toHaveText('둘째 후보.');
  await activity(page).getByRole('button', { name: '참여자 코드 적용' }).click();
  await runRerun(page);
  await expect(results(page).locator('.candidate-text')).toHaveText('셋째 후보.');
  const exported = await activityRecords(page);
  expect(exported.events.filter(event => event.requestId !== calls.corrections[2].requestId).every(event => event.participantCode === 'T01')).toBe(true);
  expect(exported.events.filter(event => event.requestId === calls.corrections[2].requestId).every(event => event.participantCode === 'T02')).toBe(true);
  expect(new Set(exported.events.map(event => event.id)).size).toBe(exported.events.length);
  await page.reload();
  await expect(activity(page).getByLabel('참여자 코드', { exact: true })).toHaveValue('T02');
  expect((await activityRecords(page)).events).toEqual(exported.events);
  page.once('dialog', dialog => dialog.dismiss());
  await activity(page).getByRole('button', { name: '행동 기록 전체 삭제' }).click();
  expect((await activityRecords(page)).events).toHaveLength(exported.events.length);
  page.once('dialog', dialog => dialog.accept());
  await activity(page).getByRole('button', { name: '행동 기록 전체 삭제' }).click();
  await expect(activity(page).getByRole('button', { name: '행동 JSON 내보내기' })).toBeDisabled();
  await expect(history(page).locator('.history-entry')).toHaveCount(3);
  await page.reload();
  await expect(activity(page).getByRole('button', { name: '행동 JSON 내보내기' })).toBeDisabled();
  await expect(history(page).locator('.history-entry')).toHaveCount(3);
});

test('activity quota failure keeps both saved and new events exportable and can recover without losing history', async ({ page }) => {
  const key = 'writing-demo.activity.v1';
  const calls = await mockModels(page, [['저장된 첫 후보.'], ['저장 재시도가 필요한 후보.']]);
  await page.goto('/');
  await firstCorrection(page, '저장 오류를 확인할 원문.');
  const original = await activityRecords(page);
  await expect.poll(async () => page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!).events.length, key)).toBe(original.events.length);
  await page.evaluate(storageKey => {
    const setItem = Storage.prototype.setItem;
    (window as Window & { activityQuota?: boolean }).activityQuota = true;
    Storage.prototype.setItem = function(name, value) {
      if (name === storageKey && (window as Window & { activityQuota?: boolean }).activityQuota) throw new DOMException('Test quota', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  }, key);
  await selectRequirement(page, 'alternative');
  await rerunButton(page).click();
  await expect(results(page).locator('.candidate-text')).toHaveText('저장 재시도가 필요한 후보.');
  await expect(activity(page).getByText(/행동 기록을 저장하지 못했습니다/)).toBeVisible();
  const inMemory = await activityRecords(page);
  expect(inMemory.events.length).toBeGreaterThan(original.events.length);
  expect(inMemory.events.some(event => event.requestId === calls.corrections[1].requestId && event.action === 'correction_received')).toBe(true);
  expect(await page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!).events.length, key)).toBe(original.events.length);
  await expect(history(page).locator('.history-entry')).toHaveCount(2);
  await page.evaluate(() => { (window as Window & { activityQuota?: boolean }).activityQuota = false; });
  await activity(page).getByRole('button', { name: '행동 기록 저장 다시 시도' }).click();
  await expect(activity(page).locator('.history-storage-status')).toHaveCount(0);
  await page.reload();
  expect((await activityRecords(page)).events).toEqual(inMemory.events);
  await expect(history(page).locator('.history-entry')).toHaveCount(2);
});

test('corrupt activity bytes are preserved while current events remain exportable until explicit reset', async ({ page }) => {
  const key = 'writing-demo.activity.v1';
  const invalid = '{unreadable-activity';
  await page.addInitScript(({ storageKey, value }) => {
    if (!sessionStorage.getItem('activity-corrupt-seeded')) {
      localStorage.setItem(storageKey, value);
      sessionStorage.setItem('activity-corrupt-seeded', 'yes');
    }
  }, { storageKey: key, value: invalid });
  const calls = await mockModels(page, [['현재 창에서 받은 후보.']]);
  await page.goto('/');
  await expect(activity(page).getByText(/저장된 행동 기록을 읽을 수 없어/)).toBeVisible();
  await firstCorrection(page, '손상된 기록과 별개의 원문.');
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe(invalid);
  const memory = await activityRecords(page);
  expect(memory.events.some(event => event.requestId === calls.corrections[0].requestId && event.action === 'correction_received')).toBe(true);
  page.once('dialog', dialog => dialog.dismiss());
  await activity(page).getByRole('button', { name: '행동 기록 저장소 초기화' }).click();
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe(invalid);
  expect((await activityRecords(page)).events).toEqual(memory.events);
  page.once('dialog', dialog => dialog.accept());
  await activity(page).getByRole('button', { name: '행동 기록 저장소 초기화' }).click();
  await expect(activity(page).getByRole('button', { name: '행동 JSON 내보내기' })).toBeDisabled();
  await expect(activity(page).locator('.history-storage-status')).toHaveCount(0);
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
  await expect(page.getByLabel('원문 입력')).toHaveValue('손상된 기록과 별개의 원문.');
  await page.reload();
  await expect(activity(page).getByRole('button', { name: '행동 JSON 내보내기' })).toBeDisabled();
  await expect(history(page).locator('.history-entry')).toHaveCount(1);
});

test('requirement selection and rerun are keyboard operable on a narrow screen without extra requests', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const calls = await mockModels(page, [['처음 보여준 후보.'], ['뜻을 유지한 새 후보.']]);
  await page.goto('/');
  await firstCorrection(page, '원래 뜻을 유지할 원문.');
  await rerunToggle(page).focus();
  await rerunToggle(page).press('Enter');
  const choice = requirement(page, '');
  await choice.focus();
  for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowDown');
  await expect(requirement(page, 'meaning')).toBeChecked();
  await expect(requirement(page, 'meaning')).toBeFocused();
  expect(calls.corrections).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/rerun-keyboard-mobile-open.png', fullPage: true });
  await page.keyboard.press('Tab');
  await expect(rerunButton(page)).toBeFocused();
  await rerunButton(page).press('Enter');
  await expect(results(page).locator('.candidate-text')).toHaveText('뜻을 유지한 새 후보.');
  await expect(rerun(page)).toHaveCount(0);
  expect(calls.corrections[1].retryContext?.requirement).toBe('meaning');
  expect(calls.explanations).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/rerun-keyboard-mobile.png', fullPage: true });
});
