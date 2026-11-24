import { expect, test, type Page } from '@playwright/test';
import type { Candidate, CorrectionInput, ExplanationInput } from '../../shared/contracts';
import type { HistoryRecord } from '../../client/src/lib/history';
import { startCorrection } from './selection-helpers';

const activityKey = 'writing-demo.activity.v1';
const participantKey = 'writing-demo.activity-participant.v1';
const historyKey = 'writing-demo.correction-history.v1';
type StorageProbe = { calls: { method: string; key: string }[]; readSaved: () => (string | null)[] };
type ProbeWindow = Window & { activityStorageProbe: StorageProbe };
const source = '금요일까지 자료 보내 주세여.';
const initial: Candidate[] = [
  { id: 'first', text: '금요일까지 자료를 보내 주세요.' },
  { id: 'second', text: '금요일까지 자료 전달을 부탁드립니다.' },
  { id: 'third', text: '자료를 금요일까지 보내 주시겠어요?' },
];
const revised: Candidate = { id: 'third-plain', text: '자료를 금요일까지 보내 주세요.' };
const cards = (page: Page) => page.locator('.correction-view .candidate-card');
const reason = (candidate: Candidate) => `${candidate.id}의 테스트용 교정 이유입니다.`;

const savedEvent = { id: 'old-event', at: '2026-11-20T00:00:00.000Z', participantCode: 'T-saved',
  sessionId: 'old-session', requestId: 'old-request', action: 'correction_requested' };
const scenarios = [
  { name: 'empty storage', activity: null, participant: null },
  { name: 'saved research records', activity: JSON.stringify({ version: 1, events: [savedEvent] }),
    participant: JSON.stringify({ version: 1, participantCode: 'T-saved' }) },
  { name: 'corrupt research records', activity: '{unreadable-activity', participant: '{unreadable-participant' },
];

for (const scenario of scenarios) {
  test(`activity is disabled with ${scenario.name} while correction, reasons, rerun, application and history still work`, async ({ page }) => {
    // Seed before instrumentation, and inspect saved bytes with the original getter
    // so assertions themselves cannot count as application reads.
    await page.addInitScript(({ keys, values }) => {
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      if (!sessionStorage.getItem('activity-disabled-seeded')) {
        keys.forEach((key, index) => {
          if (values[index] !== null) setItem.call(localStorage, key, values[index]!);
        });
        sessionStorage.setItem('activity-disabled-seeded', 'true');
      }
      const calls: StorageProbe['calls'] = [];
      Storage.prototype.getItem = function(key) {
        if (this === localStorage && keys.includes(key)) calls.push({ method: 'getItem', key });
        return getItem.call(this, key);
      };
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && keys.includes(key)) calls.push({ method: 'setItem', key });
        return setItem.call(this, key, value);
      };
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function(key) {
        if (this === localStorage && keys.includes(key)) calls.push({ method: 'removeItem', key });
        return removeItem.call(this, key);
      };
      const clear = Storage.prototype.clear;
      Storage.prototype.clear = function() {
        if (this === localStorage) calls.push({ method: 'clear', key: '*' });
        return clear.call(this);
      };
      (window as unknown as ProbeWindow).activityStorageProbe = {
        calls, readSaved: () => keys.map(key => getItem.call(localStorage, key)),
      };
    }, { keys: [activityKey, participantKey], values: [scenario.activity, scenario.participant] });

    const corrections: CorrectionInput[] = [];
    const explanations: ExplanationInput[] = [];
    await page.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON() as CorrectionInput;
      corrections.push(input);
      await route.fulfill({ json: { ...input, candidates: input.targetCandidate ? [revised] : initial } });
    });
    await page.route('**/api/explanations', async route => {
      const input = route.request().postDataJSON() as ExplanationInput;
      explanations.push(input);
      await route.fulfill({ json: { ...input, explanations: input.candidates.map(candidate => ({
        candidateId: candidate.id, explanation: reason(candidate),
      })) } });
    });
    await page.goto('/');
    await expect(page.locator('.activity-panel')).toHaveCount(0);
    await expect(page.getByLabel('참여자 코드', { exact: true })).toHaveCount(0);
    const editor = page.getByLabel('원문 입력');
    await editor.fill(source);
    await editor.evaluate((element: HTMLTextAreaElement) => {
      element.focus(); element.setSelectionRange(0, element.value.length);
    });
    await page.keyboard.press('Shift');
    await startCorrection(page);
    await expect(cards(page).locator('.candidate-text')).toHaveText(initial.map(candidate => candidate.text));
    await page.getByRole('button', { name: '교정 이유', exact: true }).click();
    await expect(cards(page).locator('.candidate-explanation > p')).toHaveText(initial.map(reason));
    await cards(page).nth(2).locator('summary').click();
    await expect(cards(page).nth(2).locator('details')).toHaveAttribute('open', '');
    await cards(page).nth(2).getByRole('button', { name: '다시 교정하기', exact: true }).click();
    const rerun = cards(page).nth(2).getByRole('region', { name: '재교정 요청', exact: true });
    await rerun.locator('input[type="radio"][value="plain"]').check();
    await rerun.getByRole('button', { name: '교정 시작', exact: true }).click();
    await expect(cards(page).locator('.candidate-text')).toHaveText([initial[0].text, initial[1].text, revised.text]);
    await expect(cards(page).locator('.candidate-explanation > p')).toHaveText([reason(initial[0]), reason(initial[1]), reason(revised)]);
    await expect(cards(page).nth(2).locator('details')).toHaveAttribute('open', '');
    expect(corrections).toHaveLength(2);
    expect(corrections[1]).toMatchObject({ sourceText: source, targetCandidate: initial[2],
      retryContext: { requirement: 'plain', previousCandidates: [initial[2]] } });
    expect(explanations.map(input => input.candidates.map(candidate => candidate.id))).toEqual([
      initial.map(candidate => candidate.id), [revised.id],
    ]);
    await cards(page).nth(2).getByRole('button', { name: '이 문장 적용', exact: true }).click();
    await expect(editor).toHaveValue(revised.text);
    await expect(cards(page).nth(2).getByRole('button', { name: '적용됨', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(key => {
      const records = JSON.parse(localStorage.getItem(key)!).records as HistoryRecord[];
      return records.find(record => record.appliedCandidateId === 'third-plain')?.explanations;
    }, historyKey)).toEqual([{ candidateId: revised.id, explanation: reason(revised) }]);

    // Neither the usual focus refresh nor a notification from another tab may
    // activate the disabled logger or reinterpret an old/corrupt research record.
    await page.evaluate(key => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, activityKey);
    const beforeReload = await page.evaluate(() => {
      const probe = (window as unknown as ProbeWindow).activityStorageProbe;
      return { calls: probe.calls, saved: probe.readSaved() };
    });
    expect(beforeReload).toEqual({ calls: [], saved: [scenario.activity, scenario.participant] });
    await page.reload();
    await page.getByRole('button', { name: '교정 이력', exact: true }).click();
    await expect(page.locator('.history-panel .history-entry')).toHaveCount(2);
    await expect(page.locator('.activity-panel')).toHaveCount(0);
    expect(await page.evaluate(() => {
      const probe = (window as unknown as ProbeWindow).activityStorageProbe;
      return { calls: probe.calls, saved: probe.readSaved() };
    })).toEqual({ calls: [], saved: [scenario.activity, scenario.participant] });
  });
}
