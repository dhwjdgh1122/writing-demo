/** A narrow text check, not a verifier of grammar, meaning, or quote attribution.
 * Complete quoted spans include literal line breaks, including rendered evidence.
 * Consume the whole span so its closing quote is not mistaken for a new opening.
 * Do not normalize spaces or line breaks:
 * spacing differences are the very issue this check is meant to catch.
 */
export function explanationQuotesMatch(source: string, candidate: string, explanation: string): boolean {
  const quotes = /'([^']+)'|"([^"]+)"|‘([^’]+)’|“([^”]+)”|「([^」]+)」|『([^』]+)』|`([^`]+)`/gu;
  for (const match of explanation.matchAll(quotes)) {
    const quote = match.slice(1).find(value => value !== undefined)!;
    if (!source.includes(quote) && !candidate.includes(quote)) return false;
  }
  return true;
}

/** Strict prose-only check. Exact quotes are allowed, but malformed/nested quotes
 * must not bypass matching. This verifies text presence, not meaning or attribution.
 * Server-rendered evidence can contain newlines and is validated separately.
 */
export function explanationProseError(source: string, candidate: string, prose: string):
  'EXPLANATION_INVALID' | 'EXPLANATION_QUOTE_MISMATCH' | undefined {
  if (!prose.trim() || /[\r\n]/u.test(prose)) return 'EXPLANATION_INVALID';
  const pairs: Record<string, string> = { "'": "'", '"': '"', '‘': '’', '“': '”', '「': '」', '『': '』', '`': '`' };
  const marks = new Set([...Object.keys(pairs), ...Object.values(pairs)]);
  let mismatch = false;
  for (let i = 0; i < prose.length; i++) {
    if (!marks.has(prose[i])) continue;
    const closing = pairs[prose[i]];
    if (!closing) return 'EXPLANATION_INVALID';
    let end = i + 1;
    while (end < prose.length && !marks.has(prose[end])) end++;
    if (end === prose.length || prose[end] !== closing) return 'EXPLANATION_INVALID';
    const quote = prose.slice(i + 1, end);
    if (!quote.trim()) return 'EXPLANATION_INVALID';
    if (!source.includes(quote) && !candidate.includes(quote)) mismatch = true;
    i = end;
  }
  return mismatch ? 'EXPLANATION_QUOTE_MISMATCH' : undefined;
}
