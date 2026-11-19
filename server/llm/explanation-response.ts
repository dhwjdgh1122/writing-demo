import { z } from 'zod';
import { countCharacters, explanationsSchema, explanationsMatch, requestIdSchema, type Candidate, type ExplanationResult } from '../../shared/contracts.js';
import { ProviderError } from './provider.js';
import { explanationProseError } from './explanation-check.js';
import { spacingOnlyExplanation } from './explanation-spacing.js';

// Reuses #22's separation of exact evidence and prose, without importing its
// experimental semantic categories, remaining-word checks or extra model calls.
const boundedText = (limit: number) => z.string().refine(text => countCharacters(text) <= limit);
const referenceSchema = z.object({ before: boundedText(2000), after: boundedText(2000) }).strict();
const draftSchema = z.object({
  candidateId: requestIdSchema,
  references: z.array(referenceSchema).min(1).max(12),
  explanation: boundedText(400),
}).strict();
// Validate ownership before inspecting individual drafts. Unknown/missing/duplicate
// IDs are a whole-response failure: never guess which candidate a draft describes.
const envelopeSchema = z.object({
  explanations: z.array(z.object({ candidateId: requestIdSchema }).passthrough()).min(1).max(3),
}).strict();

export function renderExplanationResponse(source: string, candidates: Candidate[], decoded: unknown): ExplanationResult[] {
  const envelope = envelopeSchema.safeParse(decoded);
  if (!envelope.success || !explanationsMatch(candidates, envelope.data.explanations)) throw new ProviderError('invalid');
  return envelope.data.explanations.map(raw => {
    const candidate = candidates.find(c => c.id === raw.candidateId)!;
    if (source === candidate.text) return { candidateId: candidate.id, explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' };
    const spacing = spacingOnlyExplanation(source, candidate.text);
    // As with identical candidates, derive this limited statement from the input,
    // not from model claims. Root JSON/ownership checks above still apply.
    if (spacing) return { candidateId: candidate.id, explanation: spacing };
    const failure = (error: 'EXPLANATION_INVALID' | 'EXPLANATION_QUOTE_MISMATCH'): ExplanationResult => ({ candidateId: candidate.id, error });
    const parsed = draftSchema.safeParse(raw);
    if (!parsed.success) return failure('EXPLANATION_INVALID');
    const { references, explanation } = parsed.data;
    // Allow exact quotes without rewriting model prose. Basic forms remain unquoted
    // unless actually present in this source/candidate. Meaning needs separate review.
    const proseError = explanationProseError(source, candidate.text, explanation);
    if (proseError) return failure(proseError);
    if (references.some(({ before, after }) =>
      (before && (!before.trim() || !source.includes(before)))
      || (after && (!after.trim() || !candidate.text.includes(after))))) return failure('EXPLANATION_QUOTE_MISMATCH');
    if (references.some(({ before, after }) => before === after)
      || new Set(references.map(r => JSON.stringify(r))).size !== references.length) return failure('EXPLANATION_INVALID');
    const evidence = references.map(({ before, after }) => before && after ? `‘${before}’ → ‘${after}’`
      : before ? `‘${before}’ 삭제` : `‘${after}’ 추가`).join('; ');
    const result = { candidateId: candidate.id, explanation: `${evidence}. ${explanation.trim()}` };
    return explanationsSchema.element.safeParse(result).success ? result : failure('EXPLANATION_INVALID');
  });
}

export function explanationResponseSchema(candidateIds: string[]) {
  return {
    type: 'object', properties: { explanations: { type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'object', properties: {
        candidateId: { type: 'string', enum: candidateIds },
        references: { type: 'array', items: { type: 'object', properties: {
          before: { type: 'string' }, after: { type: 'string' },
        }, required: ['before', 'after'], additionalProperties: false } },
        explanation: { type: 'string' },
      }, required: ['candidateId', 'references', 'explanation'], additionalProperties: false },
    } }, required: ['explanations'], additionalProperties: false,
  };
}
