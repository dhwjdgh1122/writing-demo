export type NumberSpelling = { text: string; count: number };
export type NumericComparison = { source: NumberSpelling[]; candidate: NumberSpelling[] };

// Literal digit spellings only. No numeric conversion, unit/role inference,
// pairing of replacements, or claim that unchanged tokens preserve meaning.
export function compareNumberSpellings(source: string, candidate: string): NumericComparison | null {
  const counts = (text: string) => {
    const result = new Map<string, number>();
    for (const match of text.matchAll(/[0-9]+(?:[.,][0-9]+)*/g)) {
      result.set(match[0], (result.get(match[0]) ?? 0) + 1);
    }
    return result;
  };
  const left = counts(source), right = counts(candidate);
  const changed = new Set([...left.keys(), ...right.keys()].filter(text => left.get(text) !== right.get(text)));
  // Avoid partial summaries: keep the existing full comparison for large lists.
  if (!changed.size || changed.size > 6 || [...changed].some(text => text.length > 24)) return null;
  const side = (values: Map<string, number>) => [...values].filter(([text]) => changed.has(text))
    .map(([text, count]) => ({ text, count }));
  return { source: side(left), candidate: side(right) };
}

export function formatNumberSpellings(values: NumberSpelling[]): string {
  return values.length ? values.map(({ text, count }) => count === 1 ? text : `${text} (${count}회)`).join(' / ') : '없음';
}
