import { useMemo } from 'react';
import { diffText, type DiffPart } from '../lib/diff';
import type { Candidate } from '../../../shared/contracts';
import { Icon } from './Icon';

function visibleSpaces(text: string) { return text.replace(/ /g, '·').replace(/\t/g, '⇥').replace(/\n/g, '↵\n'); }
function DiffLine({ parts, side, compare = false }: { parts: DiffPart[]; side: 'source' | 'candidate'; compare?: boolean }) {
  return <>{parts.filter(p => side === 'source' ? p.kind !== 'add' : p.kind !== 'remove').map((part, i) => {
    const text = compare ? visibleSpaces(part.text) : part.text;
    if (part.kind === 'remove') return <del key={i}>{text}</del>;
    if (part.kind === 'add') return <ins key={i}>{text}</ins>;
    return <span key={i}>{text}</span>;
  })}</>;
}

export function CandidateCard({ candidate, source, index, explanation, onApply }: { candidate: Candidate; source: string; index: number; explanation?: string; onApply: () => void }) {
  const comparison = useMemo(() => { try { return diffText(source, candidate.text); } catch { return null; } }, [source, candidate.text]);
  const identical = source === candidate.text;
  return <article className="candidate-card">
    <div className="candidate-heading"><span className="candidate-number">{String(index + 1).padStart(2, '0')}</span><h3>후보 {index + 1}</h3>{identical && <span className="neutral-label">원문과 동일</span>}</div>
    <p className="candidate-text">{comparison ? <DiffLine parts={comparison} side="candidate" /> : candidate.text}</p>
    {comparison?.some(p => p.kind === 'remove') && <p className="deletion-note">삭제된 내용 있음 · 원문 비교에서 확인하세요.</p>}
    {!comparison && <p className="deletion-note">변경 강조를 제공하지 못했습니다. 원문과 직접 비교해주세요.</p>}
    <details className="comparison">
      <summary>원문 비교</summary>
      <div className="comparison-content"><span className="comparison-label">원문</span><p>{comparison ? <DiffLine parts={comparison} side="source" compare /> : source}</p><span className="comparison-label">교정안</span><p>{comparison ? <DiffLine parts={comparison} side="candidate" compare /> : candidate.text}</p><small>밑줄: 추가 · 취소선: 삭제 · 점(·): 공백 · ↵: 줄바꿈</small></div>
    </details>
    {explanation && <div className="candidate-explanation"><h4>교정 이유</h4><p>{explanation}</p></div>}
    <button className="apply-button" disabled={identical} onClick={onApply}>{identical ? '변경 없음' : '이 문장 적용'}<Icon name={identical ? 'check' : 'arrow'} size={17} /></button>
  </article>;
}
