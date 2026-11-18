import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { startCorrection } from './selection-helpers';

// Offline replay, not new model calls or an assertion of candidate quality.
const cases: { sourceText: string; reportedCandidates?: string[] }[] = JSON.parse(
  readFileSync(new URL('../fixtures/correction-coverage-cases.json', import.meta.url), 'utf8'));
const recorded: { runs: { id: string; response: { sourceText: string; candidates: { text: string }[] } }[] } = JSON.parse(
  readFileSync(new URL('../../docs/evaluations/coverage-2026-11-18T10-10-00-778Z.json', import.meta.url), 'utf8'));
const linebreaks: typeof recorded = JSON.parse(
  readFileSync(new URL('../../docs/evaluations/linebreaks-revised-2026-11-18T10-43-21-455Z.json', import.meta.url), 'utf8'));
const replays = [
  ...cases[0].reportedCandidates!.map((text, i) => ({
    id: `TEAM-01-reported-${i + 1}`, sourceText: cases[0].sourceText, text,
  })),
  ...recorded.runs.flatMap(run => run.response.candidates.map(candidate => ({
    id: run.id, sourceText: run.response.sourceText, text: candidate.text,
  }))),
  ...linebreaks.runs.flatMap(run => run.response.candidates.map((candidate, index) => ({
    id: `linebreaks-${run.id}-${index + 1}`, sourceText: run.response.sourceText, text: candidate.text,
  }))),
];

for (const replay of replays) {
  test(`coverage replay ${replay.id}: exact selection, display and scoped application`, async ({ page }) => {
    const prefix = '교정하지 않을 앞 문장.\n';
    const suffix = '\n교정하지 않을 뒤 문장.';
    const original = prefix + replay.sourceText + suffix;
    let calls = 0;
    await page.route('**/api/corrections', async route => {
      const input = route.request().postDataJSON();
      expect(Object.keys(input).sort()).toEqual(['requestId', 'sourceText']);
      expect(input.sourceText).toBe(replay.sourceText);
      calls++;
      await route.fulfill({ json: { ...input, candidates: [{ id: replay.id, text: replay.text }] } });
    });
    await page.goto('/');
    const editor = page.getByLabel('원문 입력');
    await editor.fill(original);
    await editor.evaluate((el: HTMLTextAreaElement, range) => {
      el.focus(); el.setSelectionRange(range[0], range[1]);
    }, [prefix.length, prefix.length + replay.sourceText.length]);
    await page.keyboard.press('Shift');
    await startCorrection(page);
    const card = page.locator('.candidate-card');
    await expect(card).toHaveCount(1);
    // textContent preserves LF and spaces; toHaveText(string) would normalize them.
    expect(await card.locator('.candidate-text').textContent()).toBe(replay.text);
    await card.locator('summary').click();
    const visible = (text: string) => text.replace(/ /g, '·').replace(/\t/g, '⇥').replace(/\n/g, '↵\n');
    const comparison = card.locator('.comparison-content > p');
    expect(await comparison.nth(0).textContent()).toBe(visible(replay.sourceText));
    expect(await comparison.nth(1).textContent()).toBe(visible(replay.text));
    await card.getByRole('button', { name: '이 문장 적용', exact: true }).click();
    await expect(editor).toHaveValue(prefix + replay.text + suffix);
    await editor.focus();
    await page.keyboard.press('Control+z');
    await expect(editor).toHaveValue(original);
    await page.keyboard.press('Control+y');
    await expect(editor).toHaveValue(prefix + replay.text + suffix);
    expect(calls).toBe(1);
  });
}
