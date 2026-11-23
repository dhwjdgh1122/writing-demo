import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiffPart } from '../lib/diff';
import { diffExpressions } from '../lib/expression-diff';
import type { Candidate, ExplanationResult } from '../../../shared/contracts';
import { explanationChangesMatch, getExplanationChanges, type ExplanationChange } from '../../../shared/explanation-changes';
import { Icon } from './Icon';

function DiffLine({ parts, side }: { parts: DiffPart[]; side: 'source' | 'candidate' }) {
  return <>{parts.filter(p => side === 'source' ? p.kind !== 'add' : p.kind !== 'remove').map((part, i) => {
    if (part.kind === 'remove') return <del key={i}>{part.text}</del>;
    if (part.kind === 'add') return <ins key={i}>{part.text}</ins>;
    return <span key={i}>{part.text}</span>;
  })}</>;
}

// Respect both the page viewport and a scrollable history panel. Seeing only the
// edge of the box is not enough: its heading and the start of the reason must be visible.
function reasonIsVisible(panel: HTMLElement, detail: HTMLElement): boolean {
  let top = 0, bottom = window.innerHeight;
  for (let parent = panel.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) {
      const bounds = parent.getBoundingClientRect();
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
    }
  }
  const bounds = panel.getBoundingClientRect();
  const detailBounds = detail.getBoundingClientRect();
  return bounds.top >= top + 8 && Math.min(detailBounds.bottom, detailBounds.top + 100) <= bottom - 8;
}

function ChangedExpression({ change, side, index, total, active, title, panelId, onSelect }: {
  change: ExplanationChange; side: 'source' | 'candidate'; index: number; total: number;
  active: boolean; title: string; panelId: string; onSelect: (id: string) => void;
}) {
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const text = side === 'source' ? change.sourceText : change.candidateText;
  return <span className={`expression-change expression-change-${side}${active ? ' is-active' : ''}`}
    role="button" tabIndex={0} aria-pressed={active} aria-controls={panelId}
    aria-label={`${side === 'source' ? '원문' : '교정안'} 변경 ${index + 1}/${total}, ${title}, 교정 이유 보기`}
    data-change-id={change.id}
    onPointerDown={event => { pointer.current = { x: event.clientX, y: event.clientY, moved: false }; }}
    onPointerMove={event => {
      if (pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 5) pointer.current.moved = true;
    }}
    onClick={event => {
      const selection = window.getSelection();
      const selecting = selection && !selection.isCollapsed && selection.rangeCount > 0
        && selection.getRangeAt(0).intersectsNode(event.currentTarget);
      if (event.detail > 0 && (pointer.current?.moved || selecting)) return;
      onSelect(change.id);
    }}
    onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(change.id); }
    }}>
    {side === 'source' ? <del>{text}</del> : <ins>{text}</ins>}
  </span>;
}

function LinkedDiffLine({ text, changes, side, selectedId, titles, panelId, onSelect }: {
  text: string; changes: ExplanationChange[]; side: 'source' | 'candidate'; selectedId: string;
  titles: Map<string, string>; panelId: string; onSelect: (id: string) => void;
}) {
  let cursor = 0;
  const nodes: ReactNode[] = [];
  for (const [index, change] of changes.entries()) {
    const start = side === 'source' ? change.sourceStart : change.candidateStart;
    const end = side === 'source' ? change.sourceEnd : change.candidateEnd;
    nodes.push(text.slice(cursor, start));
    if (end > start) nodes.push(<ChangedExpression key={change.id} change={change} side={side} index={index} total={changes.length}
      active={change.id === selectedId} title={titles.get(change.id)!} panelId={panelId} onSelect={onSelect} />);
    cursor = end;
  }
  nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

export function CandidateCard({ candidate, source, index, explanation, explanationPending, comparisonOpen, onComparisonToggle, onApply, actionsDisabled = false, rerunControl, title, applied = false, switching = false, currentText = source }: {
  candidate: Candidate; source: string; index: number; explanation?: ExplanationResult;
  explanationPending?: string; comparisonOpen?: boolean; onComparisonToggle?: (open: boolean) => void;
  onApply?: () => void; actionsDisabled?: boolean; rerunControl?: ReactNode; title?: string;
  applied?: boolean; switching?: boolean; currentText?: string;
}) {
  const comparison = useMemo(() => { try { return diffExpressions(source, candidate.text); } catch { return null; } }, [source, candidate.text]);
  const changes = useMemo(() => { try { return getExplanationChanges(source, candidate.text); } catch { return []; } }, [source, candidate.text]);
  const linkedReasons = useMemo(() => {
    if (!explanation || 'error' in explanation || !explanation.changes?.length) return null;
    try {
      return explanationChangesMatch(source, candidate.text, explanation.changes)
        ? new Map(explanation.changes.map(reason => [reason.changeId, reason])) : null;
    } catch { return null; }
  }, [source, candidate.text, explanation]);
  const [selection, setSelection] = useState<{ source: string; candidateText: string; id: string } | null>(null);
  const selectedIndex = selection?.source === source && selection.candidateText === candidate.text
    ? Math.max(0, changes.findIndex(change => change.id === selection.id)) : 0;
  const selected = changes[selectedIndex];
  const selectedReason = selected && linkedReasons?.get(selected.id);
  const titles = new Map(Array.from(linkedReasons ?? [], ([id, reason]) => [id, reason.title]));
  const panelId = useId();
  const headingId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const [explicitSelection, setExplicitSelection] = useState(0);
  const focusRequested = useRef(false);
  useLayoutEffect(() => {
    if (!focusRequested.current) return;
    focusRequested.current = false;
    if (panel.current && detail.current && !reasonIsVisible(panel.current, detail.current)) {
      heading.current?.focus({ preventScroll: true });
      panel.current.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [explicitSelection]);
  const select = (id: string, explicit = false) => {
    setSelection({ source, candidateText: candidate.text, id });
    if (explicit) { focusRequested.current = true; setExplicitSelection(value => value + 1); }
  };
  const identical = source === candidate.text;
  const unchanged = currentText === candidate.text;
  return <article className={`candidate-card${applied ? ' is-applied' : ''}`}>
    <div className="candidate-heading">{!title && <span className="candidate-number">{String(index + 1).padStart(2, '0')}</span>}<h3>{title ?? `후보 ${index + 1}`}</h3>{applied ? <span className="applied-label"><Icon name="check" size={13} />적용됨</span> : identical && <span className="neutral-label">원문과 동일</span>}</div>
    <p className="candidate-text">{candidate.text}</p>
    <details className="comparison" open={comparisonOpen} onToggle={event => onComparisonToggle?.(event.currentTarget.open)}>
      <summary>원문 비교</summary>
      <div className="comparison-content">
        {comparison && <div className="comparison-legend" role="group" aria-label="변경 표시 안내">
          <ul className="comparison-legend-items">
            <li><del className="diff-key-remove">원문의 변경 표현</del></li>
            <li><ins className="diff-key-add">교정안의 변경 표현</ins></li>
          </ul>
          <p>{linkedReasons ? '색칠된 표현을 누르면 해당 교정 이유를 확인할 수 있습니다. 진하게 표시된 두 표현이 서로 대응합니다.' : '띄어쓰기 변화도 주변 표현과 묶어 표시합니다.'}</p>
        </div>}
        {!comparison && <p className="comparison-notice">변경 표시를 제공하지 못했습니다. 원문과 교정안을 직접 비교해주세요.</p>}
        <span className="comparison-label">원문</span><p>{linkedReasons && selected
          ? <LinkedDiffLine text={source} changes={changes} side="source" selectedId={selected.id} titles={titles} panelId={panelId} onSelect={id => select(id, true)} />
          : comparison ? <DiffLine parts={comparison} side="source" /> : source}</p>
        <span className="comparison-label">교정안</span><p>{linkedReasons && selected
          ? <LinkedDiffLine text={candidate.text} changes={changes} side="candidate" selectedId={selected.id} titles={titles} panelId={panelId} onSelect={id => select(id, true)} />
          : comparison ? <DiffLine parts={comparison} side="candidate" /> : candidate.text}</p>
      </div>
    </details>
    {explanation && (selectedReason && selected ? <div className="candidate-explanation expression-reason" id={panelId} ref={panel} aria-labelledby={headingId}>
      <div className="expression-reason-heading"><h4 id={headingId} ref={heading} tabIndex={-1}>교정 이유</h4><span className="expression-reason-progress" aria-label={`${changes.length}개 변경 중 ${selectedIndex + 1}번째`}>{selectedIndex + 1} / {changes.length}</span></div>
      <div className="expression-reason-detail" ref={detail}>
        <h5>{selectedReason.title}</h5>
        <dl className="expression-reason-quotes"><dt>원문</dt><dd className="expression-reason-source">{selected.sourceText || <span className="expression-empty">대응 표현 없음 · 새로 추가됨</span>}</dd>
          <dt>교정안</dt><dd className="expression-reason-candidate">{selected.candidateText || <span className="expression-empty">대응 표현 없음 · 삭제됨</span>}</dd></dl>
        <p className="expression-reason-copy">{selectedReason.explanation}</p>
        {selectedReason.caution && <p className="expression-reason-caution"><strong>확인할 점</strong> {selectedReason.caution}</p>}
      </div>
      <div className="expression-reason-navigation"><button type="button" className="secondary-button" disabled={selectedIndex === 0} onClick={() => select(changes[selectedIndex - 1].id)}><Icon name="back" size={14} />이전</button>
        <button type="button" className="secondary-button" disabled={selectedIndex === changes.length - 1} onClick={() => select(changes[selectedIndex + 1].id)}>다음<Icon name="arrow" size={14} /></button></div>
      <span className="expression-reason-announcement" role="status" aria-live="polite">{selectedIndex + 1} / {changes.length}, {selectedReason.title}</span>
    </div> : <div className="candidate-explanation"><h4>{'error' in explanation ? '교정 이유' : '전체 교정 이유'}</h4><p>{'error' in explanation
      ? explanation.error === 'EXPLANATION_QUOTE_MISMATCH' ? '원문·교정안과 인용이 맞지 않아 이 후보의 설명을 표시하지 않았습니다.' : '이 후보의 설명 형식을 확인하지 못해 표시하지 않았습니다.'
      : explanation.explanation}</p></div>)}
    {explanationPending && <div className="candidate-explanation"><h4>교정 이유</h4><p className="loading-message" role="status"><span className="spinner" />{explanationPending}</p></div>}
    {onApply && <div className="candidate-actions"><button className="apply-button" disabled={applied || unchanged || actionsDisabled} onClick={onApply}>{applied ? '적용됨' : unchanged ? switching ? '현재 글과 동일' : '변경 없음' : switching ? '이 후보로 바꾸기' : '이 문장 적용'}<Icon name={applied || unchanged ? 'check' : 'arrow'} size={17} /></button>{rerunControl}</div>}
  </article>;
}
