import { z } from 'zod';

export const LIMITS = { document: 20_000, selection: 1_000, candidate: 2_000, timeout: 45_000 } as const;
export const CORRECTION_CANDIDATE_COUNT = 3;
export const countCharacters = (text: string) => Array.from(text).length;
const nonBlank = (limit: number) => z.string().refine(s => s.trim().length > 0, '빈 문장은 사용할 수 없습니다.').refine(s => countCharacters(s) <= limit, `최대 ${limit}자까지 사용할 수 있습니다.`);
export const requestIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const candidateSchema = z.object({ id: requestIdSchema, text: nonBlank(LIMITS.candidate) }).strict();
export const retryRequirementSchema = z.enum(['alternative', 'polite', 'plain', 'meaning', 'errors']);
export const retryContextSchema = z.object({
  requirement: retryRequirementSchema.optional(),
  previousSourceText: nonBlank(LIMITS.selection),
  previousCandidates: z.array(candidateSchema).min(1).max(3).refine(cs => new Set(cs.map(c => c.id)).size === cs.length),
}).strict();
export type RetryRequirement = z.infer<typeof retryRequirementSchema>;
export type RetryContext = z.infer<typeof retryContextSchema>;
export function retryContextsMatch(left?: RetryContext, right?: RetryContext): boolean {
  if (!left || !right) return left === right;
  return left.requirement === right.requirement && left.previousSourceText === right.previousSourceText
    && left.previousCandidates.length === right.previousCandidates.length
    && left.previousCandidates.every((candidate, index) => candidate.id === right.previousCandidates[index].id
      && candidate.text === right.previousCandidates[index].text);
}
export const correctionInputSchema = z.object({
  requestId: requestIdSchema, sourceText: nonBlank(LIMITS.selection), retryContext: retryContextSchema.optional(),
  targetCandidate: candidateSchema.optional(),
}).strict();
// Keep previous 1–3-candidate responses and stored history readable. Fresh
// generation is checked separately by modelOutputSchema on the server.
export const correctionOutputSchema = correctionInputSchema.extend({
  candidates: z.array(candidateSchema).min(1).max(3).refine(cs => new Set(cs.map(c => c.id)).size === cs.length),
}).strict();
export const modelOutputSchema = z.array(nonBlank(LIMITS.candidate)).length(CORRECTION_CANDIDATE_COUNT);
export const candidateRevisionOutputSchema = z.array(nonBlank(LIMITS.candidate)).length(1);
export type CorrectionInput = z.infer<typeof correctionInputSchema>;
export type CorrectionResult = z.infer<typeof correctionOutputSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export function targetCandidatesMatch(left?: Candidate, right?: Candidate): boolean {
  return left && right ? left.id === right.id && left.text === right.text : left === right;
}
export const explanationInputSchema = correctionInputSchema.extend({
  candidates: z.array(candidateSchema).min(1).max(3).refine(cs => new Set(cs.map(c => c.id)).size === cs.length),
}).strict();
export const changeExplanationSchema = z.object({
  changeId: requestIdSchema, title: nonBlank(40), explanation: nonBlank(200), caution: nonBlank(160).optional(),
}).strict();
export type ChangeExplanation = z.infer<typeof changeExplanationSchema>;
export const explanationsSchema = z.array(z.object({
  candidateId: requestIdSchema, explanation: nonBlank(400),
  // Absent for older history and a model's explicit whole-candidate fallback.
  changes: z.array(changeExplanationSchema).max(LIMITS.selection).optional(),
}).strict()).min(1).max(3);
export const explanationFailureSchema = z.object({
  candidateId: requestIdSchema,
  error: z.enum(['EXPLANATION_QUOTE_MISMATCH', 'EXPLANATION_INVALID']),
}).strict();
export const explanationResultsSchema = z.array(z.union([explanationsSchema.element, explanationFailureSchema])).min(1).max(3);
export const explanationOutputSchema = explanationInputSchema.extend({ explanations: explanationResultsSchema }).strict();
export type ExplanationInput = z.infer<typeof explanationInputSchema>;
export type Explanation = z.infer<typeof explanationsSchema>[number];
export type ExplanationResult = z.infer<typeof explanationResultsSchema>[number];
export function explanationsMatch(candidates: Candidate[], explanations: { candidateId: string }[]): boolean {
  return candidates.length === explanations.length && new Set(explanations.map(e => e.candidateId)).size === candidates.length
    && explanations.every(e => candidates.some(c => c.id === e.candidateId));
}
export type ErrorCode = 'INVALID_INPUT' | 'MODEL_NOT_CONFIGURED' | 'MODEL_RESPONSE_INVALID' | 'MODEL_OUTPUT_TRUNCATED' | 'EXPLANATION_QUOTE_MISMATCH' | 'MODEL_REQUEST_FAILED' | 'MODEL_TIMEOUT' | 'MODEL_CONFIGURATION_ERROR' | 'MODEL_QUOTA_EXCEEDED' | 'MODEL_BLOCKED' | 'MODEL_UNAVAILABLE' | 'NOT_FOUND';
export type ApiErrorBody = { requestId: string | null; error: { code: ErrorCode; message: string; retryable: boolean } };

export function selectionProblem(text: string | undefined): string | null {
  if (!text || !text.trim()) return '교정할 문장을 선택해주세요.';
  if (countCharacters(text) > LIMITS.selection) return '선택한 내용이 1,000자를 넘었어요. 범위를 줄여서 나누어 교정해주세요.';
  return null;
}
