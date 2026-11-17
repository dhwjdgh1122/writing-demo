import { explanationInputSchema, type Candidate, type Explanation } from '../../shared/contracts.js';
import { buildSingleExplanationInput } from './explanation-input.js';
import { renderSingleExplanation, parseChangeExplanation, parseUsageReview, type ExplanationDraftObserver } from './explanation-output.js';
import { ProviderError } from './provider.js';

// Manual evaluation only: observes attempted model calls, never credentials or envelopes.
export type ExplanationCallObserver = (candidateId: string, phase: 'changes' | 'usage') => void;
type Generate = (input: ReturnType<typeof buildSingleExplanationInput>, signal: AbortSignal) => Promise<unknown>;
type Review = (input: { sourceText: string; candidateText: string }, signal: AbortSignal) => Promise<unknown>;

export async function explainCandidates(source: string, candidates: Candidate[], signal: AbortSignal,
  generate: Generate, review: Review, observe?: ExplanationDraftObserver, observeCall?: ExplanationCallObserver): Promise<Explanation[]> {
  if (!explanationInputSchema.safeParse({ requestId: 'internal', sourceText: source, candidates }).success) {
    throw new ProviderError('invalid');
  }
  const results: Explanation[] = [];
  // One shared deadline; no retries, parallel requests, or partial success response.
  for (const candidate of candidates) {
    signal.throwIfAborted();
    if (candidate.text === source) {
      results.push(renderSingleExplanation(source, candidate, { notes: [], surfaceChanges: [], meaningChanges: [] }));
      continue;
    }
    observeCall?.(candidate.id, 'changes');
    const decoded = await generate(buildSingleExplanationInput(source, candidate), signal);
    signal.throwIfAborted();
    const changes = parseChangeExplanation(decoded);
    // Do not spend a review call on a change explanation that already fails validation.
    renderSingleExplanation(source, candidate, { ...changes, notes: [] }, rows => observe?.(rows, 'changes'));
    signal.throwIfAborted();
    observeCall?.(candidate.id, 'usage');
    const reviewed = await review({ sourceText: source, candidateText: candidate.text }, signal);
    signal.throwIfAborted();
    const notes = parseUsageReview(source, candidate, reviewed);
    results.push(renderSingleExplanation(source, candidate, { ...changes, notes }, rows => observe?.(rows, 'combined')));
  }
  return results;
}
