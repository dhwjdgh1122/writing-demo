import { expect, test, type Page } from '@playwright/test';
import type { Candidate, CorrectionInput, ExplanationInput } from '../../shared/contracts';
import { startCorrection } from './selection-helpers';

const source = '금요일 까지 자료를 보내 주세여.\n회의 전에 내용을 읽어보세여.\n궁금한점은 따로 적어 주세여.';
const corrected = '금요일까지 자료를 보내 주세요.\n회의 전에 내용을 읽어 보세요.\n궁금한 점은 따로 적어 주세요.';
const alternative = '금요일까지 자료 전달을 부탁드립니다.\n회의 전에 내용을 확인해 주세요.\n궁금한 점은 별도로 기록해 주세요.';
const cards = (page: Page) => page.locator('.correction-view .candidate-card');
const editor = (page: Page) => page.getByLabel('원문 입력');

async function select(page: Page, start: number, end: number) {
  await editor(page).evaluate((element: HTMLTextAreaElement, range) => {
    element.focus();
    element.setSelectionRange(range[0], range[1]);
  }, [start, end]);
  await page.keyboard.press('Shift');
}

async function prepare(page: Page, document: string, options: { source?: string; corrected?: string; failRerun?: boolean } = {}) {
  const selected = options.source ?? source;
  const candidates: Candidate[] = [
    { id: 'visibility-first', text: alternative },
    { id: 'visibility-second', text: '회의 전에 자료를 확인해 주세요.' },
    { id: 'visibility-third', text: options.corrected ?? corrected },
  ];
  await page.route('**/api/health', route => route.fulfill({ json: { modelConfigured: true } }));
  await page.route('**/api/corrections', async route => {
    const input = route.request().postDataJSON() as CorrectionInput;
    if (input.targetCandidate && options.failRerun) {
      await route.fulfill({ status: 503, json: { requestId: input.requestId,
        error: { code: 'MODEL_UNAVAILABLE', message: '테스트용 일시 오류입니다.', retryable: true } } });
      return;
    }
    await route.fulfill({ json: { ...input, candidates } });
  });
  await page.route('**/api/explanations', async route => {
    const input = route.request().postDataJSON() as ExplanationInput;
    await route.fulfill({ json: { ...input, explanations: input.candidates.map(candidate => ({
      candidateId: candidate.id,
      explanation: '원문과 교정안의 실제 차이를 확인하기 위한 테스트 설명입니다. '.repeat(8).trim(),
    })) } });
  });
  await page.goto('/');
  await editor(page).fill(document);
  const start = document.indexOf(selected);
  expect(start).toBeGreaterThanOrEqual(0);
  await select(page, start, start + selected.length);
  await startCorrection(page);
  await expect(cards(page)).toHaveCount(3);
  await page.getByRole('button', { name: '교정 이유', exact: true }).click();
  await expect(cards(page).locator('.candidate-explanation > p')).toHaveCount(3);
  for (let index = 0; index < 3; index++) await cards(page).nth(index).locator('summary').click();
  return { start, selected, candidates };
}

// Textareas expose selection offsets, but not DOM Range rectangles. Lay out a
// test-only copy using the browser's computed text styles, then project its text
// rectangles through the real textarea's scroll position. This does not call
// the production scrolling helper or rely on a scrollTop value chosen by it.
async function selectedGeometry(page: Page) {
  return editor(page).evaluate((element: HTMLTextAreaElement) => {
    const style = getComputedStyle(element);
    const mirror = document.createElement('div');
    for (const property of style) mirror.style.setProperty(property, style.getPropertyValue(property));
    Object.assign(mirror.style, {
      position: 'fixed', left: '-20000px', top: '0', visibility: 'hidden',
      width: `${element.clientWidth + element.clientLeft * 2}px`, height: 'auto',
      minHeight: '0', maxHeight: 'none', overflow: 'visible', margin: '0',
      whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    });
    const text = document.createTextNode(element.value);
    mirror.append(text);
    document.body.append(mirror);
    const range = document.createRange();
    range.setStart(text, element.selectionStart);
    range.setEnd(text, element.selectionEnd);
    const box = element.getBoundingClientRect();
    const mirrorBox = mirror.getBoundingClientRect();
    const fragments = [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({
      left: box.left + rect.left - mirrorBox.left - element.scrollLeft,
      right: box.left + rect.right - mirrorBox.left - element.scrollLeft,
      top: box.top + rect.top - mirrorBox.top - element.scrollTop,
      bottom: box.top + rect.bottom - mirrorBox.top - element.scrollTop,
    }));
    mirror.remove();
    const clipTop = box.top + element.clientTop;
    const clipBottom = clipTop + element.clientHeight;
    const visible = (fragment: (typeof fragments)[number]) => {
      if (!fragment) return false;
      const x = Math.max(box.left + element.clientLeft + 1, Math.min((fragment.left + fragment.right) / 2, box.right - 2));
      const y = (fragment.top + fragment.bottom) / 2;
      return fragment.top >= clipTop - 1 && fragment.bottom <= clipBottom + 1
        && fragment.top >= 0 && fragment.bottom <= window.innerHeight
        && document.elementFromPoint(x, y) === element;
    };
    return {
      start: element.selectionStart, end: element.selectionEnd,
      selected: element.value.slice(element.selectionStart, element.selectionEnd),
      firstVisible: visible(fragments[0]), lastVisible: visible(fragments.at(-1)!),
      scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
      focused: document.activeElement === element,
    };
  });
}

async function expectAppliedVisible(page: Page, text: string, start: number, wholeRange = true) {
  await expect.poll(async () => {
    const geometry = await selectedGeometry(page);
    return { selected: geometry.selected, start: geometry.start, end: geometry.end,
      firstVisible: geometry.firstVisible, lastVisible: wholeRange ? geometry.lastVisible : true,
      focused: geometry.focused };
  }).toEqual({ selected: text, start, end: start + text.length, firstVisible: true, lastVisible: true, focused: true });
}

for (const position of ['beginning', 'middle', 'end'] as const) {
  test(`applying below expanded comparisons reveals the ${position} of a long document`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    const surrounding = Array.from({ length: 55 }, (_, index) => `그대로 남겨 둘 주변 문장 ${index + 1}입니다.\n`).join('');
    const prefix = position === 'beginning' ? '' : surrounding;
    const suffix = position === 'end' ? '' : `\n${surrounding}`;
    const { start } = await prepare(page, prefix + source + suffix);
    const apply = cards(page).nth(2).getByRole('button', { name: '이 문장 적용', exact: true });
    await apply.scrollIntoViewIfNeeded();
    // Make the internal editor scroll wrong as well as placing it above the
    // viewport. Both scrolling layers must be corrected by the application.
    await editor(page).evaluate((element: HTMLTextAreaElement, atBeginning) => {
      element.scrollTop = atBeginning ? element.scrollHeight : 0;
    }, position === 'beginning');
    expect((await selectedGeometry(page)).firstVisible).toBe(false);
    await apply.click();
    await expect(editor(page)).toHaveValue(prefix + corrected + suffix);
    await expectAppliedVisible(page, corrected, start);
    await expect(cards(page).nth(2).getByRole('button', { name: '적용됨', exact: true })).toBeDisabled();
    if (position === 'beginning') {
      await expect(page.locator('.floating-correction')).toHaveCount(0);
      await page.screenshot({ path: 'test-results/apply-visible-desktop.png' });
    }

    if (position === 'middle') {
      await cards(page).first().getByRole('button', { name: '이 후보로 바꾸기', exact: true }).click();
      await expect(editor(page)).toHaveValue(prefix + alternative + suffix);
      await expectAppliedVisible(page, alternative, start);
      await expect(cards(page).first().getByRole('button', { name: '적용됨', exact: true })).toBeDisabled();
    }
  });
}

test('soft-wrapped text is revealed without being hidden by sticky controls on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const selected = '금요일 까지 자료를 보내 주세여. 궁금한점은 적어 주세여.';
  const replacement = '금요일까지 자료를 보내 주세요. 궁금한 점은 적어 주세요.';
  const prefix = '앞부분을 그대로 유지하는 긴 문장입니다. '.repeat(45);
  const suffix = ' 뒷부분도 그대로 유지하는 긴 문장입니다.'.repeat(40);
  const { start } = await prepare(page, prefix + selected + suffix, { source: selected, corrected: replacement });
  await editor(page).evaluate((element: HTMLTextAreaElement) => { element.scrollTop = 0; });
  await cards(page).nth(2).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(editor(page)).toHaveValue(prefix + replacement + suffix);
  await expectAppliedVisible(page, replacement, start);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/apply-visible-mobile.png' });
});

test('an applied passage taller than the editor reveals its beginning rather than only its end', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const selected = '길게 설명할 문장을 골랐습니다.';
  const replacement = Array.from({ length: 18 }, (_, index) => `${index + 1}번째 줄의 적용된 긴 문장입니다.`).join('\n');
  const prefix = '앞쪽 문장은 그대로 남습니다.\n'.repeat(25);
  const suffix = '\n뒤쪽 문장도 그대로 남습니다.'.repeat(25);
  const { start } = await prepare(page, prefix + selected + suffix, { source: selected, corrected: replacement });
  await cards(page).nth(2).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expect(editor(page)).toHaveValue(prefix + replacement + suffix);
  await expectAppliedVisible(page, replacement, start, false);
});

test('the temporary application emphasis does not overwrite a new selection or subsequent typing', async ({ page }) => {
  const prefix = '새로 선택할 앞 문장입니다.\n';
  await prepare(page, prefix + source);
  await cards(page).nth(2).getByRole('button', { name: '이 문장 적용', exact: true }).click();
  await expectAppliedVisible(page, corrected, prefix.length);
  await select(page, 0, 5);
  // Allow the application highlight to finish; it must not restore its old range.
  await page.waitForTimeout(2700);
  expect(await editor(page).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 5]);
  await editor(page).press('ArrowRight');
  await page.keyboard.insertText('직접 수정');
  await expect(editor(page)).toHaveValue(prefix.slice(0, 5) + '직접 수정' + prefix.slice(5) + corrected);
  await expect(cards(page)).toHaveCount(0);
});

test('a failed candidate rerun keeps its controls visible instead of jumping to the original editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await prepare(page, source, { failRerun: true });
  const card = cards(page).nth(2);
  await card.getByRole('button', { name: '다시 교정하기', exact: true }).click();
  const rerun = card.getByRole('region', { name: '재교정 요청', exact: true });
  await rerun.locator('input[value="plain"]').check();
  await rerun.getByRole('button', { name: '교정 시작', exact: true }).click();
  await expect(rerun).toContainText('테스트용 일시 오류');
  await expect(rerun.getByRole('button', { name: '다시 시도', exact: true })).toBeEnabled();
  await expect(rerun).toBeInViewport();
  await expect(editor(page)).not.toBeFocused();
  await expect(editor(page)).toHaveValue(source);
  expect((await selectedGeometry(page)).firstVisible).toBe(false);
});
