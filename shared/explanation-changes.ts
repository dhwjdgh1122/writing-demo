import type { Candidate, ChangeExplanation } from './contracts.js';
import { diffExpressions } from './expression-diff.js';

export type ExplanationChange = {
  id: string;
  sourceText: string;
  candidateText: string;
  sourceStart: number;
  sourceEnd: number;
  candidateStart: number;
  candidateEnd: number;
};

// Stable, non-security identity. Offsets distinguish repeated expressions; the
// text fingerprint prevents carrying a selection into a changed comparison.
function comparisonIdentity(source: string, candidate: string): string {
  let hash = 0xcbf29ce484222325n;
  const input = JSON.stringify([source, candidate]);
  for (let index = 0; index < input.length; index++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(input.charCodeAt(index))) * 0x100000001b3n);
  }
  return hash.toString(36);
}

/** Display change groups, not grammatical/semantic claims. All offsets are UTF-16. */
export function getExplanationChanges(source: string, candidate: string): ExplanationChange[] {
  const parts = diffExpressions(source, candidate);
  const identity = comparisonIdentity(source, candidate);
  const changes: ExplanationChange[] = [];
  let sourceOffset = 0, candidateOffset = 0;
  for (let index = 0; index < parts.length;) {
    const part = parts[index];
    if (part.kind === 'same') {
      sourceOffset += part.text.length;
      candidateOffset += part.text.length;
      index++;
      continue;
    }
    const sourceStart = sourceOffset, candidateStart = candidateOffset;
    while (parts[index] && parts[index].kind !== 'same') {
      if (parts[index].kind === 'remove') sourceOffset += parts[index].text.length;
      else candidateOffset += parts[index].text.length;
      index++;
    }
    changes.push({
      id: `change-${identity}-${sourceStart}-${sourceOffset}-${candidateStart}-${candidateOffset}`,
      sourceText: source.slice(sourceStart, sourceOffset), candidateText: candidate.slice(candidateStart, candidateOffset),
      sourceStart, sourceEnd: sourceOffset, candidateStart, candidateEnd: candidateOffset,
    });
  }
  return changes;
}

/** Never guess a link from array order or from a repeated substring. */
export function explanationChangesMatch(source: string, candidate: string, explanations: Pick<ChangeExplanation, 'changeId'>[]): boolean {
  const expected = getExplanationChanges(source, candidate);
  const ids = new Set(explanations.map(change => change.changeId));
  return expected.length === explanations.length && ids.size === explanations.length
    && expected.every(change => ids.has(change.id));
}

export function candidatesWithExplanationChanges(source: string, candidates: Candidate[]) {
  return candidates.map(candidate => ({ ...candidate, changes: getExplanationChanges(source, candidate.text) }));
}
