// Offline diagnostic only. Not imported by the product and never a semantic verdict.
// Unlike the UI's single LCS path, retain both possibilities across all minimum
// unit-cost insert/delete/substitute alignments: 1 = no U+0020 edit, 2 = a space edit.
export function alignSpaces(source, candidate) {
  if (typeof source !== 'string' || typeof candidate !== 'string') return { status: 'unsupported-input' };
  if (/[^\S ]/u.test(source + candidate)) return { status: 'unsupported-whitespace' };
  const a = [...source], b = [...candidate];
  if (a.length > 1000 || b.length > 2000 || (a.length + 1) * (b.length + 1) > 1_000_000)
    return { status: 'comparison-limit' };
  let costs = new Uint16Array(b.length + 1), masks = new Uint8Array(b.length + 1);
  masks[0] = 1;
  for (let j = 1; j <= b.length; j++) { costs[j] = j; masks[j] = b[j - 1] === ' ' ? 2 : masks[j - 1]; }
  const edit = (mask, touchesSpace) => touchesSpace ? 2 : mask;
  for (let i = 1; i <= a.length; i++) {
    const nextCosts = new Uint16Array(b.length + 1), nextMasks = new Uint8Array(b.length + 1);
    nextCosts[0] = i; nextMasks[0] = edit(masks[0], a[i - 1] === ' ');
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === b[j - 1];
      const diagonal = costs[j - 1] + (same ? 0 : 1), deletion = costs[j] + 1, insertion = nextCosts[j - 1] + 1;
      const best = Math.min(diagonal, deletion, insertion);
      nextCosts[j] = best;
      let mask = 0;
      if (diagonal === best) mask |= edit(masks[j - 1], !same && (a[i - 1] === ' ' || b[j - 1] === ' '));
      if (deletion === best) mask |= edit(masks[j], a[i - 1] === ' ');
      if (insertion === best) mask |= edit(nextMasks[j - 1], b[j - 1] === ' ');
      nextMasks[j] = mask;
    }
    costs = nextCosts; masks = nextMasks;
  }
  return { status: masks[b.length] === 1 ? 'preserved' : masks[b.length] === 2 ? 'changed' : 'ambiguous',
    editDistance: costs[b.length], alignmentModel: 'unit-cost-code-point-Levenshtein' };
}

function outsideQuotes(text) {
  const pairs = new Map([["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”'], ['「', '」'], ['『', '』'], ['`', '`']]);
  const closers = new Set(pairs.values());
  let closing = null, result = '';
  for (const char of text) {
    if (closing) {
      if (char === closing) closing = null;
      else if (pairs.has(char) || closers.has(char)) return null;
      result += ' ';
    } else if (pairs.has(char)) { closing = pairs.get(char); result += ' '; }
    else if (closers.has(char)) return null;
    else result += char;
  }
  return closing ? null : result;
}

export function auditSpacingClaim(source, candidate, explanation) {
  if (typeof explanation !== 'string') return { verdict: 'abstained', reason: 'missing-explanation' };
  const prose = outsideQuotes(explanation);
  if (prose === null) return { verdict: 'abstained', reason: 'ambiguous-quotes' };
  // Deliberately abstain on negation, hypothetical/advisory or metalinguistic
  // contexts. This is a limited assertion recognizer, not a Korean NLP parser.
  if (/예시|예를|가정|만약|경우|설명|문구|라고|아니|않|없이|없|유지|그대로|필요|추천|해야|하세요|할 수|수 있|[?？]/u.test(prose))
    return { verdict: 'abstained', reason: 'context-not-covered' };
  const claims = [...prose.matchAll(/띄어쓰기를\s+(?:수정|교정|변경)(?:했습니다|하였습니다|했다)(?=[.!。]|$)/gu)].map(m => m[0]);
  if (!claims.length) return { verdict: 'not-covered', reason: 'no-supported-assertion' };
  const alignment = alignSpaces(source, candidate);
  if (alignment.status === 'preserved') return { verdict: 'review-needed', reason: 'spacing-claim-versus-preserved-alignment', claims, alignment };
  if (alignment.status === 'changed') return { verdict: 'not-covered', reason: 'space-edit-exists-not-a-quality-pass', claims, alignment };
  return { verdict: 'abstained', reason: alignment.status, claims, alignment };
}
