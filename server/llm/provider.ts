import type { Candidate } from '../../shared/contracts.js';
/** Provider-neutral contract. Providers return text candidates; the app supplies IDs. */
export interface CorrectionProvider {
  readonly configured: boolean;
  generateCandidates(sourceText: string, signal: AbortSignal): Promise<unknown>;
  generateExplanations?(sourceText: string, candidates: Candidate[], signal: AbortSignal): Promise<unknown>;
}

export type ProviderFailure = 'configuration' | 'quota' | 'blocked' | 'invalid' | 'unavailable';
export type ExplanationValidationFailure = 'schema' | 'ids' | 'reference' | 'change' | 'length';
export interface ExplanationSchemaDiagnostic {
  path: (string | number)[];
  code: string;
  extraFields?: string[];
  recognizedKind?: string;
}
export class ProviderError extends Error {
  constructor(readonly kind: ProviderFailure, readonly validationFailure?: ExplanationValidationFailure,
    readonly schemaDiagnostics?: ExplanationSchemaDiagnostic[]) {
    super(`Model provider failure: ${kind}`);
    this.name = 'ProviderError';
  }
}

export const unavailableProvider: CorrectionProvider = {
  configured: false,
  async generateCandidates() { throw new Error('Model provider is not configured'); },
};
