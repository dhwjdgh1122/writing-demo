import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { correctionInputSchema, explanationInputSchema, explanationResultsSchema, explanationsMatch, modelOutputSchema, candidateRevisionOutputSchema, LIMITS, requestIdSchema, type ApiErrorBody, type ErrorCode, type ExplanationResult } from '../shared/contracts.js';
import { ProviderError, unavailableProvider, type CorrectionProvider } from './llm/provider.js';
import { explanationQuotesMatch } from './llm/explanation-check.js';

export function createApp(provider: CorrectionProvider = unavailableProvider, timeoutMs: number = LIMITS.timeout) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Current + prior bounded selections/candidates can exceed 64 KiB when JSON
  // uses Unicode escapes. Field lengths and candidate counts are still checked below.
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', modelConfigured: provider.configured }));
  app.post(['/api/corrections', '/api/explanations'], async (req, res) => {
    const explaining = req.path === '/api/explanations';
    const label = explaining ? '설명' : '교정';
    const parsed = explaining ? explanationInputSchema.safeParse(req.body) : correctionInputSchema.safeParse(req.body);
    const explanationInput = explaining ? explanationInputSchema.safeParse(req.body) : null;
    const requestId = requestIdSchema.safeParse(req.body?.requestId);
    const fail = (status: number, code: ErrorCode, message: string, retryable: boolean) => {
      if (!res.destroyed) res.status(status).json({ requestId: requestId.success ? requestId.data : null, error: { code, message, retryable } } satisfies ApiErrorBody);
    };
    if (!parsed.success) { fail(400, 'INVALID_INPUT', explaining ? '설명할 원문과 후보를 확인해주세요.' : '교정할 문장을 1,000자 이내로 선택해주세요.', false); return; }
    const invalidCandidateMessage = parsed.data.targetCandidate
      ? '선택한 후보의 새 교정안 1개를 완전하게 받지 못했습니다. 기존 후보는 유지됩니다. 다시 시도해주세요.'
      : '교정 후보 3개를 완전하게 받지 못했습니다. 원문은 유지됩니다. 다시 실행해주세요.';
    if (!provider.configured || (explaining && !provider.generateExplanations)) { fail(503, 'MODEL_NOT_CONFIGURED', `AI 연결 설정이 필요합니다. 아직 ${label} 모델이 연결되지 않았습니다.`, false); return; }
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timeout');
    try {
      const raw = await Promise.race([
        explanationInput?.success
          ? provider.generateExplanations!(explanationInput.data.sourceText, explanationInput.data.candidates, controller.signal, explanationInput.data.retryContext, explanationInput.data.targetCandidate)
          : provider.generateCandidates(parsed.data.sourceText, controller.signal, parsed.data.retryContext, parsed.data.targetCandidate),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(timedOut); controller.abort(); }, timeoutMs); }),
      ]);
      if (explanationInput?.success) {
        const explanations = explanationResultsSchema.safeParse(raw);
        if (!explanations.success || !explanationsMatch(explanationInput.data.candidates, explanations.data)) {
          fail(502, 'MODEL_RESPONSE_INVALID', '현재 후보에 맞는 설명을 받지 못했습니다. 설명을 다시 요청해주세요.', true); return;
        }
        const results: ExplanationResult[] = explanations.data.map(item => {
          if ('error' in item) return item;
          const candidate = explanationInput.data.candidates.find(c => c.id === item.candidateId)!;
          return explanationQuotesMatch(explanationInput.data.sourceText, candidate.text, item.explanation) ? item
            : { candidateId: item.candidateId, error: 'EXPLANATION_QUOTE_MISMATCH' };
        });
        if (!res.destroyed) res.json({ ...explanationInput.data, explanations: results });
        return;
      }
      const candidates = (parsed.data.targetCandidate ? candidateRevisionOutputSchema : modelOutputSchema).safeParse(raw);
      if (!candidates.success) { fail(502, 'MODEL_RESPONSE_INVALID', invalidCandidateMessage, true); return; }
      if (!res.destroyed) res.json({ ...parsed.data, candidates: candidates.data.map(text => ({ id: randomUUID(), text })) });
    } catch (error) {
      if (error === timedOut) fail(504, 'MODEL_TIMEOUT', `${label} 요청 시간이 초과되었습니다. 다시 시도해주세요.`, true);
      else if (error instanceof ProviderError) {
        switch (error.kind) {
          case 'configuration': fail(503, 'MODEL_CONFIGURATION_ERROR', 'AI 연결 설정을 확인해주세요. API 키·모델명·프로젝트 접근 권한을 확인한 뒤 다시 실행해주세요.', false); break;
          case 'quota': fail(429, 'MODEL_QUOTA_EXCEEDED', 'AI 사용량 또는 요청 횟수 제한에 도달했습니다. 사용 중인 AI 서비스의 한도·크레딧을 확인한 뒤 다시 실행해주세요.', true); break;
          case 'blocked': fail(422, 'MODEL_BLOCKED', `AI가 이 문장의 ${label} 결과를 제공하지 않았습니다. 입력 문장을 확인해주세요.`, false); break;
          case 'truncated': fail(502, 'MODEL_OUTPUT_TRUNCATED', explaining
            ? '설명 결과가 출력 한도에서 중단됐습니다. 교정 후보는 유지되며 원문 비교와 적용은 계속할 수 있습니다. 필요하면 설명을 다시 요청해주세요.'
            : '교정 결과가 출력 한도에서 중단됐습니다. 원문은 유지됩니다. 선택 범위를 줄여 나누어 교정해주세요.', true); break;
          case 'invalid': fail(502, 'MODEL_RESPONSE_INVALID', explaining
            ? '완전한 설명 결과를 받지 못했습니다. 원문은 유지됩니다. 다시 실행해주세요.'
            : invalidCandidateMessage, true); break;
          case 'unavailable': fail(503, 'MODEL_UNAVAILABLE', 'AI 서비스가 일시적으로 요청을 처리하지 못했습니다. 잠시 기다린 뒤 다시 실행해주세요. 원문은 유지됩니다.', true); break;
        }
      }
      else if (!res.destroyed) fail(502, 'MODEL_REQUEST_FAILED', `${label} 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.`, true);
    } finally { clearTimeout(timer); res.off('close', onClose); }
  });
  app.use('/api', (_req, res) => res.status(404).json({ requestId: null, error: { code: 'NOT_FOUND', message: '지원하지 않는 요청입니다.', retryable: false } } satisfies ApiErrorBody));
  const handleError: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ requestId: null, error: { code: 'INVALID_INPUT', message: '요청 형식이나 크기를 확인해주세요.', retryable: false } } satisfies ApiErrorBody);
  };
  app.use(handleError);
  return app;
}
