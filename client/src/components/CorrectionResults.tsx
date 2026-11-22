import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LIMITS, type CorrectionResult, type ExplanationResult, type ExplanationInput } from '../../../shared/contracts';
import { requestExplanations, requestFailureCode } from '../lib/api';
import { activityErrorCode, type ActivityInput } from '../lib/activity';
import { CandidateCard } from './CandidateCard';
import { Icon } from './Icon';

// The parent keys this component by correction request ID. New results unmount
// the old view and cancelling its request. Completed explanations can be saved
// by the parent without making history responsible for model requests.
export type ExplanationActivity = Omit<ActivityInput, 'action'> & {
  action: 'explanation_requested' | 'explanation_received' | 'explanation_failed' | 'explanation_cancelled';
};
type ActivityContext = Pick<ActivityInput, 'parentRequestId' | 'phase' | 'requirement'>;
type ExplanationAttempt = { input: ExplanationInput; activity: Omit<ExplanationActivity, 'action'> };

export function CorrectionResults({ result, onApply, onExplanationResults, activityContext, onActivity, disabled = false, renderRerun }: {
  result: CorrectionResult;
  onApply: (id: string) => void;
  onExplanationResults?: (requestId: string, explanations: ExplanationResult[]) => void;
  activityContext?: ActivityContext;
  onActivity?: (event: ExplanationActivity) => void;
  disabled?: boolean;
  renderRerun?: (candidateId: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState<ExplanationAttempt | null>(null);
  const [loading, setLoading] = useState(false);
  const [explanations, setExplanations] = useState<ExplanationResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const explanationCallback = useRef(onExplanationResults);
  const activityCallback = useRef(onActivity);
  const requesting = useRef(false);

  useEffect(() => { explanationCallback.current = onExplanationResults; }, [onExplanationResults]);
  useEffect(() => { activityCallback.current = onActivity; }, [onActivity]);
  useEffect(() => {
    if (explanations) explanationCallback.current?.(result.requestId, explanations);
  }, [explanations, result.requestId]);

  useEffect(() => {
    if (!attempt) return;
    requesting.current = true;
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, LIMITS.timeout + 5_000);
    requestExplanations(attempt.input, controller.signal)
      .then(value => {
        if (!active) return;
        settled = true;
        setExplanations(previous => [...(previous ?? []).filter(e => !value.some(v => v.candidateId === e.candidateId)), ...value]);
        activityCallback.current?.({ ...attempt.activity, action: 'explanation_received' });
        for (const explanation of value) {
          if ('error' in explanation) activityCallback.current?.({ ...attempt.activity, action: 'explanation_failed',
            candidateId: explanation.candidateId, errorCode: activityErrorCode(explanation.error) });
        }
      })
      .catch(reason => {
        if (!active) return;
        settled = true;
        setError(timedOut ? '설명 응답 시간이 초과되었습니다. 다시 시도해주세요.' : reason instanceof Error ? reason.message : '설명을 불러오지 못했습니다.');
        activityCallback.current?.({ ...attempt.activity, action: 'explanation_failed',
          errorCode: timedOut ? 'CLIENT_TIMEOUT' : requestFailureCode(reason) });
      })
      .finally(() => { clearTimeout(timer); if (active) { requesting.current = false; setLoading(false); } });
    return () => {
      active = false; clearTimeout(timer); controller.abort(); requesting.current = false;
      if (!settled) activityCallback.current?.({ ...attempt.activity, action: 'explanation_cancelled' });
    };
  }, [attempt]);

  const failedIds = explanations?.filter(e => 'error' in e).map(e => e.candidateId) ?? [];
  const request = () => {
    if (requesting.current || disabled) return;
    requesting.current = true;
    const attemptId = crypto.randomUUID();
    const activity = { ...activityContext, requestId: result.requestId, attemptId };
    const input: ExplanationInput = { requestId: attemptId, sourceText: result.sourceText,
      candidates: failedIds.length ? result.candidates.filter(c => failedIds.includes(c.id)) : result.candidates,
      ...(result.retryContext ? { retryContext: result.retryContext } : {}) };
    activityCallback.current?.({ ...activity, action: 'explanation_requested' });
    setError(null); setLoading(true); setAttempt({ input, activity });
  };
  const toggleDisabled = disabled && !explanations;
  const toggle = () => {
    if (toggleDisabled) return;
    setOpen(!open);
    if (!open && !explanations && !loading && !error) request();
  };
  return <>
    <div className="explanation-toolbar"><button type="button" className="panel-action explanation-toggle" disabled={toggleDisabled} aria-expanded={open} aria-controls={panelId} onClick={toggle}><Icon name="message" size={18} /><span>교정 이유</span></button></div>
    <div id={panelId} hidden={!open} className="explanation-status" role="status" aria-live="polite">
      {loading && <p className="loading-message"><span className="spinner" />교정 이유를 확인하고 있습니다.</p>}
      {error && <div className="explanation-error"><p>{error}</p><button className="text-button" onClick={request} disabled={loading || disabled}>설명 다시 시도</button></div>}
      {explanations?.some(e => 'explanation' in e) && <p>원문과 후보를 비교한 AI 설명입니다. 실제 차이와 함께 확인해주세요.</p>}
      {!error && failedIds.length > 0 && <div className="explanation-error"><p>{failedIds.length === result.candidates.length ? '교정 이유를 표시하지 못했습니다.' : '일부 후보의 교정 이유를 표시하지 못했습니다.'} {disabled ? '원문 비교를 확인할 수 있습니다.' : '후보 비교와 적용은 계속할 수 있습니다.'}</p><button className="text-button" onClick={request} disabled={loading || disabled}>실패한 설명 다시 시도</button></div>}
    </div>
    <div className="candidate-list">{result.candidates.map((candidate, index) => <CandidateCard key={candidate.id} candidate={candidate} index={index} source={result.sourceText}
      explanation={open ? explanations?.find(e => e.candidateId === candidate.id) : undefined} onApply={() => onApply(candidate.id)}
      actionsDisabled={disabled} rerunControl={renderRerun?.(candidate.id)} />)}</div>
    <p className="result-disclaimer">데모 생성 결과입니다. 적용 전에 내용을 확인해주세요.</p>
  </>;
}
