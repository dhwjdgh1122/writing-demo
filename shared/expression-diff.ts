import { LIMITS } from './contracts.js';
export type DiffPart = { kind: 'same' | 'add' | 'remove'; text: string };

type Chunk = { source: string; candidate: string; changed: boolean; word?: boolean; gap?: boolean };
const onlyWhitespace = (text: string) => !/\S/u.test(text);

/** Display-only grouping by whitespace-delimited expressions, not grammar or meaning. */
export function diffExpressions(source: string, candidate: string): DiffPart[] {
  if (Array.from(source).length > LIMITS.selection || Array.from(candidate).length > LIMITS.candidate) {
    throw new Error('Comparison limit exceeded');
  }
  const words = (text: string) => Array.from(text.matchAll(/\S+/gu), match => ({
    text: match[0], start: match.index!, end: match.index! + match[0].length,
  }));
  const a = words(source), b = words(candidate);
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i].text === b[j].text ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const chunks: Chunk[] = [];
  function gap(before: string, after: string) {
    if (before === after) {
      if (before) chunks.push({ source: before, candidate: after, changed: false });
      return;
    }
    if (onlyWhitespace(before) && onlyWhitespace(after)) {
      chunks.push({ source: before, candidate: after, changed: true, gap: true });
      return;
    }
    // Keep identical boundary spacing outside a replacement, without normalizing either string.
    let start = 0, end = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start] && onlyWhitespace(before[start])) start++;
    while (end < Math.min(before.length, after.length) - start && before[before.length - end - 1] === after[after.length - end - 1]
      && onlyWhitespace(before[before.length - end - 1])) end++;
    if (start) chunks.push({ source: before.slice(0, start), candidate: after.slice(0, start), changed: false });
    chunks.push({ source: before.slice(start, before.length - end), candidate: after.slice(start, after.length - end), changed: true });
    if (end) chunks.push({ source: before.slice(before.length - end), candidate: after.slice(after.length - end), changed: false });
  }

  let i = 0, j = 0, sourceEnd = 0, candidateEnd = 0;
  while (i < a.length && j < b.length) {
    if (a[i].text === b[j].text) {
      gap(source.slice(sourceEnd, a[i].start), candidate.slice(candidateEnd, b[j].start));
      chunks.push({ source: a[i].text, candidate: b[j].text, changed: false, word: true });
      sourceEnd = a[i++].end;
      candidateEnd = b[j++].end;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  gap(source.slice(sourceEnd), candidate.slice(candidateEnd));

  // A changed gap alone is hard to see. Include its neighboring matched expressions as context.
  for (let index = 0; index < chunks.length; index++) {
    if (!chunks[index].gap) continue;
    if (chunks[index - 1]?.word) chunks[index - 1].changed = true;
    if (chunks[index + 1]?.word) chunks[index + 1].changed = true;
  }
  const parts: DiffPart[] = [];
  const append = (kind: DiffPart['kind'], text: string) => {
    if (!text) return;
    const previous = parts.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else parts.push({ kind, text });
  };
  for (let index = 0; index < chunks.length;) {
    if (!chunks[index].changed) {
      append('same', chunks[index++].source);
      continue;
    }
    let before = '', after = '';
    do {
      before += chunks[index].source;
      after += chunks[index++].candidate;
    } while (chunks[index]?.changed);
    append('remove', before);
    append('add', after);
  }
  return parts;
}
