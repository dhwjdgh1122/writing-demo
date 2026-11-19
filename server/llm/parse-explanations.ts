import { z } from 'zod';
import { explanationsSchema, explanationsMatch, requestIdSchema, type Candidate, type ExplanationResult } from '../../shared/contracts.js';
import { ProviderError } from './provider.js';

// Keep the existing model response contract. Only isolate errors after every ID
// is accounted for; malformed envelopes and ambiguous ownership remain fatal.
const envelopeSchema = z.object({
  explanations: z.array(z.object({ candidateId: requestIdSchema }).passthrough()).min(1).max(3),
}).strict();

export function parseExplanations(source: string, candidates: Candidate[], raw: unknown): ExplanationResult[] {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success || !explanationsMatch(candidates, envelope.data.explanations)) throw new ProviderError('invalid');
  return envelope.data.explanations.map(item => {
    const parsed = explanationsSchema.element.safeParse(item);
    if (!parsed.success) return { candidateId: item.candidateId, error: 'EXPLANATION_INVALID' };
    return candidates.find(c => c.id === item.candidateId)!.text === source
      ? { candidateId: item.candidateId, explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' }
      : parsed.data;
  });
}
