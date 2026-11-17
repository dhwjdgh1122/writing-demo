import { explanationInputSchema, type Candidate, type Explanation } from '../../shared/contracts.js';
import { buildSingleExplanationInput } from './explanation-input.js';
import { renderSingleExplanation, type ExplanationDraftObserver } from './explanation-output.js';
import { ProviderError } from './provider.js';

// Manual evaluation only: observes attempted model calls, never credentials or envelopes.
export type ExplanationCallObserver = (candidateId: string) => void;
type Generate = (input: ReturnType<typeof buildSingleExplanationInput>, signal: AbortSignal) => Promise<unknown>;

export async function explainCandidates(source: string, candidates: Candidate[], signal: AbortSignal,
  generate: Generate, observe?: ExplanationDraftObserver, observeCall?: ExplanationCallObserver): Promise<Explanation[]> {
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
    observeCall?.(candidate.id);
    const decoded = await generate(buildSingleExplanationInput(source, candidate), signal);
    signal.throwIfAborted();
    results.push(renderSingleExplanation(source, candidate, decoded, observe));
  }
  return results;
}
