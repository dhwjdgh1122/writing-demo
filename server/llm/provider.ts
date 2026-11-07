import type { Candidate } from '../../shared/contracts.js';
/** Provider-neutral contract. Providers return text candidates; the app supplies IDs. */
export interface CorrectionProvider {
  readonly configured: boolean;
  generateCandidates(sourceText: string, signal: AbortSignal): Promise<unknown>;
  generateExplanations?(sourceText: string, candidates: Candidate[], signal: AbortSignal): Promise<unknown>;
}

export type ProviderFailure = 'configuration' | 'quota' | 'blocked' | 'invalid' | 'unavailable';
export class ProviderError extends Error {
  constructor(readonly kind: ProviderFailure) {
    super(`Model provider failure: ${kind}`);
    this.name = 'ProviderError';
  }
}

export const unavailableProvider: CorrectionProvider = {
  configured: false,
  async generateCandidates() { throw new Error('Model provider is not configured'); },
};
