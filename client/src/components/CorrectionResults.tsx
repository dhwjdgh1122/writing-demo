import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LIMITS, type Candidate, type CorrectionResult, type ExplanationResult, type ExplanationInput } from '../../../shared/contracts';
import { requestExplanations, requestFailureCode } from '../lib/api';
import { activityErrorCode, type ActivityInput } from '../lib/activity';
import type { Snapshot } from '../state/editor';
import { CandidateCard } from './CandidateCard';
import { Icon } from './Icon';

// A batch keeps its view while one candidate is replaced. Each candidate's
// explanation still belongs to the request that actually generated it.
export type ExplanationActivity = Omit<ActivityInput, 'action'> & {
  action: 'explanation_requested' | 'explanation_received' | 'explanation_failed' | 'explanation_cancelled';
};
type ActivityContext = Pick<ActivityInput, 'parentRequestId' | 'phase' | 'requirement'>;
type ExplanationAttempt = { input: ExplanationInput; historyRequestId: string; activity: Omit<ExplanationActivity, 'action'> };
type ExplanationError = { candidateIds: string[]; message: string };

export function CorrectionResults({ result, candidateOrigins, onApply, onExplanationResults, activityContext, onActivity, disabled = false, renderRerun }: {
  result: CorrectionResult;
  candidateOrigins?: Record<string, Snapshot>;
  onApply: (id: string) => void;
  onExplanationResults?: (requestId: string, explanations: ExplanationResult[]) => void;
  activityContext?: ActivityContext;
  onActivity?: (event: ExplanationActivity) => void;
  disabled?: boolean;
  renderRerun?: (candidateId: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [attempts, setAttempts] = useState<ExplanationAttempt[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [explanations, setExplanations] = useState<ExplanationResult[] | null>(null);
  const [errors, setErrors] = useState<ExplanationError[]>([]);
  const [comparisonsOpen, setComparisonsOpen] = useState<boolean[]>([]);
  const panelId = useId();
  const explanationCallback = useRef(onExplanationResults);
  const activityCallback = useRef(onActivity);
  const requesting = useRef(false);
  // A failed automatic request must stay failed until the user explicitly retries.
  // New candidate IDs are eligible once, even when an earlier request is pending.
  const requestedCandidateIds = useRef(new Set<string>());
  const currentCandidates = useRef(result.candidates);
  currentCandidates.current = result.candidates;

  useEffect(() => { explanationCallback.current = onExplanationResults; }, [onExplanationResults]);
  useEffect(() => { activityCallback.current = onActivity; }, [onActivity]);
  useEffect(() => {
    if (!attempts) return;
    requesting.current = true;
    let active = true;
    const running = attempts.map(attempt => ({ attempt, controller: new AbortController(), timedOut: false, settled: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined }));
    const pending = running.map(task => {
      const { attempt, controller } = task;
      task.timer = setTimeout(() => { task.timedOut = true; controller.abort(); }, LIMITS.timeout + 5_000);
      return requestExplanations(attempt.input, controller.signal)
      .then(value => {
        if (!active) return;
        task.settled = true;
        // A late response may still describe unchanged siblings, but never the
        // replacement candidate. Save the response only to its original record.
        const visible = value.filter(explanation => currentCandidates.current.some(candidate => candidate.id === explanation.candidateId
          && attempt.input.candidates.some(sent => sent.id === candidate.id && sent.text === candidate.text)));
        setExplanations(previous => [...(previous ?? []).filter(explanation => currentCandidates.current.some(candidate => candidate.id === explanation.candidateId)
          && !visible.some(value => value.candidateId === explanation.candidateId)), ...visible]);
        explanationCallback.current?.(attempt.historyRequestId, value);
        activityCallback.current?.({ ...attempt.activity, action: 'explanation_received' });
        for (const explanation of value) {
          if ('error' in explanation) activityCallback.current?.({ ...attempt.activity, action: 'explanation_failed',
            candidateId: explanation.candidateId, errorCode: activityErrorCode(explanation.error) });
        }
      })
      .catch(reason => {
        if (!active) return;
        task.settled = true;
        setErrors(previous => [...previous, { candidateIds: attempt.input.candidates.map(candidate => candidate.id),
          message: task.timedOut ? '설명 응답 시간이 초과되었습니다. 다시 시도해주세요.' : reason instanceof Error ? reason.message : '설명을 불러오지 못했습니다.' }]);
        activityCallback.current?.({ ...attempt.activity, action: 'explanation_failed',
          errorCode: task.timedOut ? 'CLIENT_TIMEOUT' : requestFailureCode(reason) });
      })
      .finally(() => { clearTimeout(task.timer); });
    });
    void Promise.allSettled(pending).then(() => { if (active) { requesting.current = false; setLoading(false); } });
    return () => {
      active = false; requesting.current = false;
      for (const task of running) {
        clearTimeout(task.timer); task.controller.abort();
        if (!task.settled) activityCallback.current?.({ ...task.attempt.activity, action: 'explanation_cancelled' });
      }
    };
  }, [attempts]);

  const visibleExplanations = explanations?.filter(explanation => result.candidates.some(candidate => candidate.id === explanation.candidateId)) ?? [];
  const failedIds = visibleExplanations.filter(explanation => 'error' in explanation).map(explanation => explanation.candidateId);
  const missingIds = result.candidates.filter(candidate => !visibleExplanations.some(explanation => explanation.candidateId === candidate.id)).map(candidate => candidate.id);
  // Include queued IDs on the first replacement render, before the request effect,
  // so restoring the rerun button's position uses the final loading layout.
  const pendingIds = result.candidates.filter(candidate => missingIds.includes(candidate.id) && !requestedCandidateIds.current.has(candidate.id)
    || loading && attempts?.some(attempt => attempt.input.candidates.some(sent => sent.id === candidate.id))).map(candidate => candidate.id);
  const error = errors.find(error => error.candidateIds.some(id => result.candidates.some(candidate => candidate.id === id)))?.message;
  const request = useCallback((candidateIds: string[]) => {
    if (requesting.current || disabled) return;
    const groups = new Map<string, { origin?: Snapshot; candidates: Candidate[] }>();
    for (const candidate of result.candidates) {
      if (!candidateIds.includes(candidate.id)) continue;
      const origin = candidateOrigins?.[candidate.id];
      const key = origin?.requestId ?? result.requestId;
      const group = groups.get(key) ?? { origin, candidates: [] };
      group.candidates.push(candidate); groups.set(key, group);
    }
    if (!groups.size) return;
    requesting.current = true;
    const nextAttempts = Array.from(groups, ([historyRequestId, { origin, candidates }]) => {
      const attemptId = crypto.randomUUID();
      const retryContext = origin ? origin.retryContext : result.retryContext;
      const targetCandidate = origin ? origin.targetCandidate : result.targetCandidate;
      const activity = { ...(origin ? { parentRequestId: origin.parentRequestId, phase: origin.phase, requirement: retryContext?.requirement,
        ...(targetCandidate ? { targetCandidateId: targetCandidate.id } : {}) } : activityContext),
        requestId: historyRequestId, attemptId };
      const input: ExplanationInput = { requestId: attemptId, sourceText: origin?.sourceText ?? result.sourceText, candidates,
        ...(retryContext ? { retryContext } : {}), ...(targetCandidate ? { targetCandidate } : {}) };
      activityCallback.current?.({ ...activity, action: 'explanation_requested' });
      for (const candidate of candidates) requestedCandidateIds.current.add(candidate.id);
      return { input, activity, historyRequestId };
    });
    setErrors(previous => previous.map(error => ({ ...error, candidateIds: error.candidateIds.filter(id => !candidateIds.includes(id)) }))
      .filter(error => error.candidateIds.length > 0));
    setLoading(true); setAttempts(nextAttempts);
  }, [disabled, result, candidateOrigins, activityContext]);
  useEffect(() => {
    if (!open || loading || disabled) return;
    // Wait for the previous batch to finish so its unchanged siblings can still
    // receive their explanations. Closing the view leaves new IDs unrequested.
    const unrequestedIds = missingIds.filter(id => !requestedCandidateIds.current.has(id));
    if (unrequestedIds.length) request(unrequestedIds);
  }, [open, loading, disabled, missingIds, request]);
  const retry = () => request([...missingIds, ...failedIds]);
  const toggleDisabled = disabled && !open && !visibleExplanations.length;
  const toggle = () => {
    if (toggleDisabled) return;
    setOpen(!open);
  };
  return <>
    <div className="explanation-toolbar"><button type="button" className="panel-action explanation-toggle" disabled={toggleDisabled} aria-expanded={open} aria-controls={panelId} onClick={toggle}><Icon name="message" size={18} /><span>교정 이유</span></button></div>
    <div id={panelId} hidden={!open} className="explanation-status" role="status" aria-live="polite">
      {pendingIds.length > 0 && <p className="loading-message"><span className="spinner" />교정 이유를 확인하고 있습니다.</p>}
      {error && <div className="explanation-error"><p>{error}</p><button className="text-button" onClick={retry} disabled={loading || disabled}>설명 다시 시도</button></div>}
      {visibleExplanations.some(e => 'explanation' in e) && <p>원문과 후보를 비교한 AI 설명입니다. 실제 차이와 함께 확인해주세요.</p>}
      {!error && failedIds.length > 0 && <div className="explanation-error"><p>{failedIds.length === result.candidates.length ? '교정 이유를 표시하지 못했습니다.' : '일부 후보의 교정 이유를 표시하지 못했습니다.'} {disabled ? '원문 비교를 확인할 수 있습니다.' : '후보 비교와 적용은 계속할 수 있습니다.'}</p><button className="text-button" onClick={retry} disabled={loading || disabled}>실패한 설명 다시 시도</button></div>}
    </div>
    <div className="candidate-list">{result.candidates.map((candidate, index) => <CandidateCard key={candidate.id} candidate={candidate} index={index} source={result.sourceText}
      explanation={open ? visibleExplanations.find(e => e.candidateId === candidate.id) : undefined} onApply={() => onApply(candidate.id)}
      explanationPending={open && missingIds.includes(candidate.id) && pendingIds.includes(candidate.id)
        ? candidateOrigins?.[candidate.id]?.targetCandidate ? '새 교정 이유를 생성하고 있습니다.' : '교정 이유를 생성하고 있습니다.' : undefined}
      comparisonOpen={comparisonsOpen[index] ?? false} onComparisonToggle={value => setComparisonsOpen(previous => {
        if ((previous[index] ?? false) === value) return previous;
        const next = [...previous]; next[index] = value; return next;
      })}
      actionsDisabled={disabled} rerunControl={renderRerun?.(candidate.id)} />)}</div>
    <p className="result-disclaimer">데모 생성 결과입니다. 적용 전에 내용을 확인해주세요.</p>
  </>;
}
