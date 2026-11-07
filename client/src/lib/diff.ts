import { LIMITS } from '../../../shared/contracts';

export type DiffPart = { kind: 'same' | 'add' | 'remove'; text: string };
/** Code-point LCS; constrained to a selected sentence, never the full document. */
export function diffText(source: string, candidate: string): DiffPart[] {
  const a = Array.from(source), b = Array.from(candidate);
  if (a.length > LIMITS.selection || b.length > LIMITS.candidate) throw new Error('Comparison limit exceeded');
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text; else parts.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push('same', a[i++]); j++; }
    else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) push('remove', a[i++]);
    else push('add', b[j++]);
  }
  return parts;
}
