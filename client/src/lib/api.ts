import { correctionOutputSchema, explanationOutputSchema, explanationsMatch, retryContextsMatch, targetCandidatesMatch, type ExplanationInput, type CorrectionInput, type ErrorCode } from '../../../shared/contracts';

export type RequestFailureCode = ErrorCode | 'CLIENT_RESPONSE_INVALID' | 'CLIENT_REQUEST_FAILED' | 'CLIENT_TIMEOUT';
const knownCodes = new Set<string>(['INVALID_INPUT', 'MODEL_NOT_CONFIGURED', 'MODEL_RESPONSE_INVALID', 'MODEL_OUTPUT_TRUNCATED', 'EXPLANATION_QUOTE_MISMATCH', 'MODEL_REQUEST_FAILED', 'MODEL_TIMEOUT', 'MODEL_CONFIGURATION_ERROR', 'MODEL_QUOTA_EXCEEDED', 'MODEL_BLOCKED', 'MODEL_UNAVAILABLE', 'NOT_FOUND']);
export class ApiRequestError extends Error {
  constructor(message: string, readonly code: RequestFailureCode) { super(message); this.name = 'ApiRequestError'; }
}
export const requestFailureCode = (error: unknown): RequestFailureCode => error instanceof ApiRequestError ? error.code : 'CLIENT_REQUEST_FAILED';
const responseError = (data: unknown, fallback: string) => {
  const body = data as { error?: { message?: unknown; code?: unknown } } | null;
  return new ApiRequestError(typeof body?.error?.message === 'string' ? body.error.message : fallback,
    typeof body?.error?.code === 'string' && knownCodes.has(body.error.code) ? body.error.code as ErrorCode : 'CLIENT_REQUEST_FAILED');
};
async function responseJson(response: Response) {
  try { return await response.json(); }
  catch { throw new ApiRequestError('서버 응답을 읽지 못했습니다. 다시 시도해주세요.', 'CLIENT_RESPONSE_INVALID'); }
}

export async function requestExplanations(input: ExplanationInput, signal: AbortSignal) {
  const response = await fetch('/api/explanations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  const data = await responseJson(response);
  if (!response.ok) throw responseError(data, '설명을 불러오지 못했습니다. 다시 시도해주세요.');
  const parsed = explanationOutputSchema.safeParse(data);
  if (!parsed.success || parsed.data.requestId !== input.requestId || parsed.data.sourceText !== input.sourceText
    || !retryContextsMatch(parsed.data.retryContext, input.retryContext) || !targetCandidatesMatch(parsed.data.targetCandidate, input.targetCandidate) || parsed.data.candidates.length !== input.candidates.length
    || !input.candidates.every(c => parsed.data.candidates.some(p => p.id === c.id && p.text === c.text))
    || !explanationsMatch(input.candidates, parsed.data.explanations)) throw new ApiRequestError('현재 후보와 일치하는 설명을 받지 못했습니다. 다시 시도해주세요.', 'CLIENT_RESPONSE_INVALID');
  return parsed.data.explanations;
}

export async function requestCorrection(input: CorrectionInput, signal: AbortSignal) {
  const response = await fetch('/api/corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  const data = await responseJson(response);
  if (!response.ok) throw responseError(data, '서버 요청에 실패했습니다. 다시 시도해주세요.');
  const parsed = correctionOutputSchema.safeParse(data);
  if (!parsed.success || parsed.data.requestId !== input.requestId || parsed.data.sourceText !== input.sourceText
    || !retryContextsMatch(parsed.data.retryContext, input.retryContext) || !targetCandidatesMatch(parsed.data.targetCandidate, input.targetCandidate)
    || (input.targetCandidate && parsed.data.candidates.length !== 1)) throw new ApiRequestError('현재 선택과 일치하는 교정 결과를 받지 못했습니다. 다시 실행해주세요.', 'CLIENT_RESPONSE_INVALID');
  return parsed.data;
}
