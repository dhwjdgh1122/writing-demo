import { z } from 'zod';

export const LIMITS = { document: 20_000, selection: 1_000, candidate: 2_000, timeout: 45_000 } as const;
export const countCharacters = (text: string) => Array.from(text).length;
const nonBlank = (limit: number) => z.string().refine(s => s.trim().length > 0, '빈 문장은 사용할 수 없습니다.').refine(s => countCharacters(s) <= limit, `최대 ${limit}자까지 사용할 수 있습니다.`);
export const requestIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const correctionInputSchema = z.object({ requestId: requestIdSchema, sourceText: nonBlank(LIMITS.selection) }).strict();
export const candidateSchema = z.object({ id: requestIdSchema, text: nonBlank(LIMITS.candidate) }).strict();
export const correctionOutputSchema = z.object({
  requestId: requestIdSchema,
  sourceText: nonBlank(LIMITS.selection),
  candidates: z.array(candidateSchema).min(1).max(3).refine(cs => new Set(cs.map(c => c.id)).size === cs.length),
}).strict();
export const modelOutputSchema = z.array(nonBlank(LIMITS.candidate)).min(1).max(3);
export type CorrectionInput = z.infer<typeof correctionInputSchema>;
export type CorrectionResult = z.infer<typeof correctionOutputSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export const explanationInputSchema = correctionInputSchema.extend({
  candidates: z.array(candidateSchema).min(1).max(3).refine(cs => new Set(cs.map(c => c.id)).size === cs.length),
}).strict();
export const explanationsSchema = z.array(z.object({ candidateId: requestIdSchema, explanation: nonBlank(400) }).strict()).min(1).max(3);
export const explanationOutputSchema = explanationInputSchema.extend({ explanations: explanationsSchema }).strict();
export type ExplanationInput = z.infer<typeof explanationInputSchema>;
export type Explanation = z.infer<typeof explanationsSchema>[number];
export function explanationsMatch(candidates: Candidate[], explanations: Explanation[]): boolean {
  return candidates.length === explanations.length && new Set(explanations.map(e => e.candidateId)).size === candidates.length
    && explanations.every(e => candidates.some(c => c.id === e.candidateId));
}
export type ErrorCode = 'INVALID_INPUT' | 'MODEL_NOT_CONFIGURED' | 'MODEL_RESPONSE_INVALID' | 'EXPLANATION_QUOTE_MISMATCH' | 'MODEL_REQUEST_FAILED' | 'MODEL_TIMEOUT' | 'MODEL_CONFIGURATION_ERROR' | 'MODEL_QUOTA_EXCEEDED' | 'MODEL_BLOCKED' | 'MODEL_UNAVAILABLE' | 'NOT_FOUND';
export type ApiErrorBody = { requestId: string | null; error: { code: ErrorCode; message: string; retryable: boolean } };

export function selectionProblem(text: string | undefined): string | null {
  if (!text || !text.trim()) return '교정할 문장을 선택해주세요.';
  if (countCharacters(text) > LIMITS.selection) return '선택한 문장은 최대 1,000자까지 교정할 수 있습니다.';
  return null;
}
