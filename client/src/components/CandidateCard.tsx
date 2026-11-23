import { useMemo, type ReactNode } from 'react';
import type { DiffPart } from '../lib/diff';
import { diffExpressions } from '../lib/expression-diff';
import type { Candidate, ExplanationResult } from '../../../shared/contracts';
import { Icon } from './Icon';

function DiffLine({ parts, side }: { parts: DiffPart[]; side: 'source' | 'candidate' }) {
  return <>{parts.filter(p => side === 'source' ? p.kind !== 'add' : p.kind !== 'remove').map((part, i) => {
    if (part.kind === 'remove') return <del key={i}>{part.text}</del>;
    if (part.kind === 'add') return <ins key={i}>{part.text}</ins>;
    return <span key={i}>{part.text}</span>;
  })}</>;
}

export function CandidateCard({ candidate, source, index, explanation, explanationPending, comparisonOpen, onComparisonToggle, onApply, actionsDisabled = false, rerunControl, title }: {
  candidate: Candidate; source: string; index: number; explanation?: ExplanationResult;
  explanationPending?: string; comparisonOpen?: boolean; onComparisonToggle?: (open: boolean) => void;
  onApply?: () => void; actionsDisabled?: boolean; rerunControl?: ReactNode; title?: string;
}) {
  const comparison = useMemo(() => { try { return diffExpressions(source, candidate.text); } catch { return null; } }, [source, candidate.text]);
  const identical = source === candidate.text;
  return <article className="candidate-card">
    <div className="candidate-heading">{!title && <span className="candidate-number">{String(index + 1).padStart(2, '0')}</span>}<h3>{title ?? `후보 ${index + 1}`}</h3>{identical && <span className="neutral-label">원문과 동일</span>}</div>
    <p className="candidate-text">{candidate.text}</p>
    <details className="comparison" open={comparisonOpen} onToggle={event => onComparisonToggle?.(event.currentTarget.open)}>
      <summary>원문 비교</summary>
      <div className="comparison-content">
        {comparison && <div className="comparison-legend" role="group" aria-label="변경 표시 안내">
          <ul className="comparison-legend-items">
            <li><del className="diff-key-remove">원문의 변경 표현</del></li>
            <li><ins className="diff-key-add">교정안의 변경 표현</ins></li>
          </ul>
          <p>띄어쓰기 변화도 주변 표현과 묶어 표시합니다.</p>
        </div>}
        {!comparison && <p className="comparison-notice">변경 표시를 제공하지 못했습니다. 원문과 교정안을 직접 비교해주세요.</p>}
        <span className="comparison-label">원문</span><p>{comparison ? <DiffLine parts={comparison} side="source" /> : source}</p>
        <span className="comparison-label">교정안</span><p>{comparison ? <DiffLine parts={comparison} side="candidate" /> : candidate.text}</p>
      </div>
    </details>
    {explanation && <div className="candidate-explanation"><h4>교정 이유</h4><p>{'error' in explanation
      ? explanation.error === 'EXPLANATION_QUOTE_MISMATCH' ? '원문·교정안과 인용이 맞지 않아 이 후보의 설명을 표시하지 않았습니다.' : '이 후보의 설명 형식을 확인하지 못해 표시하지 않았습니다.'
      : explanation.explanation}</p></div>}
    {explanationPending && <div className="candidate-explanation"><h4>교정 이유</h4><p className="loading-message" role="status"><span className="spinner" />{explanationPending}</p></div>}
    {onApply && <div className="candidate-actions"><button className="apply-button" disabled={identical || actionsDisabled} onClick={onApply}>{identical ? '변경 없음' : '이 문장 적용'}<Icon name={identical ? 'check' : 'arrow'} size={17} /></button>{rerunControl}</div>}
  </article>;
}
