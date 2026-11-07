/** A narrow text check, not a verifier of grammar, meaning, or quote attribution.
 * Only complete, single-line quoted spans are inspected. Do not normalize spaces:
 * spacing differences are the very issue this check is meant to catch.
 */
export function explanationQuotesMatch(source: string, candidate: string, explanation: string): boolean {
  const quotes = /'([^'\r\n]+)'|"([^"\r\n]+)"|‘([^’\r\n]+)’|“([^”\r\n]+)”|「([^」\r\n]+)」|『([^』\r\n]+)』|`([^`\r\n]+)`/gu;
  for (const match of explanation.matchAll(quotes)) {
    const quote = match.slice(1).find(value => value !== undefined)!;
    if (!source.includes(quote) && !candidate.includes(quote)) return false;
  }
  return true;
}
