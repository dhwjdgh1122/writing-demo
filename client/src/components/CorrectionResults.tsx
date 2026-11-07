import { useEffect, useId, useState } from 'react';
import { LIMITS, type CorrectionResult, type Explanation } from '../../../shared/contracts';
import { requestExplanations } from '../lib/api';
import { CandidateCard } from './CandidateCard';
import { Icon } from './Icon';

// The parent keys this component by correction request ID. New results unmount
// the old view, cancelling its request and discarding its in-memory explanations.
export function CorrectionResults({ result, onApply }: { result: CorrectionResult; onApply: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [explanations, setExplanations] = useState<Explanation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, LIMITS.timeout + 5_000);
    requestExplanations({ requestId: crypto.randomUUID(), sourceText: result.sourceText, candidates: result.candidates }, controller.signal)
      .then(value => { if (active) setExplanations(value); })
      .catch(reason => { if (active) setError(timedOut ? '설명 응답 시간이 초과되었습니다. 다시 시도해주세요.' : reason instanceof Error ? reason.message : '설명을 불러오지 못했습니다.'); })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [attempt, result]);

  const request = () => { if (loading) return; setError(null); setLoading(true); setAttempt(n => n + 1); };
  const toggle = () => {
    setOpen(!open);
    if (!open && !explanations && !loading && !error) request();
  };
  return <>
    <div className="explanation-toolbar"><button className="explanation-toggle" aria-expanded={open} aria-controls={panelId} onClick={toggle}><Icon name="info" size={16} />교정 이유<span>{open ? '접기' : '보기'}</span></button></div>
    <div id={panelId} hidden={!open} className="explanation-status" role="status" aria-live="polite">
      {loading && <p className="loading-message"><span className="spinner" />교정 이유를 확인하고 있습니다.</p>}
      {error && <div className="explanation-error"><p>{error}</p><button className="text-button" onClick={request} disabled={loading}>설명 다시 시도</button></div>}
      {explanations && <p>원문과 후보를 비교한 AI 설명입니다. 실제 차이와 함께 확인해주세요.</p>}
    </div>
    <p className="diff-legend"><span />밑줄은 원문에서 달라진 표현입니다.</p>
    <div className="candidate-list">{result.candidates.map((candidate, index) => <CandidateCard key={candidate.id} candidate={candidate} index={index} source={result.sourceText}
      explanation={open ? explanations?.find(e => e.candidateId === candidate.id)?.explanation : undefined} onApply={() => onApply(candidate.id)} />)}</div>
    <p className="result-disclaimer">데모 생성 결과입니다. 적용 전에 내용을 확인해주세요.</p>
  </>;
}
