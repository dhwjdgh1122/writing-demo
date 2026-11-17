import type { Candidate } from '../../shared/contracts.js';
import { diffText } from '../../shared/diff.js';

export const MAX_EXPLANATION_EDITS = 32;
const CONTEXT_POINTS = 12;
type Edit = {
  sourceStart: number;
  candidateStart: number;
  before: string;
  after: string;
  sourceContext: string;
  candidateContext: string;
  changeType: 'spacing-only' | 'text-change';
};

// Offsets are UTF-16, matching String.slice. Context boundaries preserve code points.
function context(text: string, start: number, length: number): string {
  return Array.from(text.slice(0, start)).slice(-CONTEXT_POINTS).join('')
    + text.slice(start, start + length)
    + Array.from(text.slice(start + length)).slice(0, CONTEXT_POINTS).join('');
}

function comparison(source: string, candidate: string) {
  const edits: Edit[] = [];
  let sourceOffset = 0, candidateOffset = 0;
  let pending: { sourceStart: number; candidateStart: number; before: string; after: string } | undefined;
  const flush = () => {
    if (!pending) return;
    edits.push({
      ...pending,
      sourceContext: context(source, pending.sourceStart, pending.before.length),
      candidateContext: context(candidate, pending.candidateStart, pending.after.length),
      // Mechanical comparison only: not a spelling or meaning classification.
      changeType: pending.before.replace(/\s/gu, '') === pending.after.replace(/\s/gu, '') ? 'spacing-only' : 'text-change',
    });
    pending = undefined;
  };
  for (const part of diffText(source, candidate)) {
    if (part.kind === 'same') {
      flush();
      sourceOffset += part.text.length;
      candidateOffset += part.text.length;
    } else {
      pending ??= { sourceStart: sourceOffset, candidateStart: candidateOffset, before: '', after: '' };
      if (part.kind === 'remove') { pending.before += part.text; sourceOffset += part.text.length; }
      else { pending.after += part.text; candidateOffset += part.text.length; }
    }
    // Never send a partially truncated edit list as a complete comparison.
    if (edits.length > MAX_EXPLANATION_EDITS) return { mode: 'whole-text' as const, edits: [] };
  }
  flush();
  return edits.length > MAX_EXPLANATION_EDITS
    ? { mode: 'whole-text' as const, edits: [] }
    : { mode: 'edits' as const, edits };
}

/** Derive model-only comparison data from the selected source and each candidate. */
export function buildExplanationInput(sourceText: string, candidates: Candidate[]) {
  return {
    sourceText,
    candidates: candidates.map(candidate => ({ ...candidate, comparison: comparison(sourceText, candidate.text) })),
  };
}

/** One model request never receives another candidate or a server-assigned ID. */
export function buildSingleExplanationInput(sourceText: string, candidate: Candidate) {
  return { sourceText, candidate: { text: candidate.text, comparison: comparison(sourceText, candidate.text) } };
}
