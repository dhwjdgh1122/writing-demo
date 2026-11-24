import { useEffect, useId, useRef, useState } from 'react';
import type { HistoryRecord } from '../lib/history';
import { CandidateCard } from './CandidateCard';
import { Icon } from './Icon';
import { HISTORY_EXPORT_ENABLED } from '../config/features';

type HistoryStatus = 'loading' | 'saved' | 'saving' | 'memory-only' | 'error' | 'corrupt';

type HistoryPanelProps = {
  hidden: boolean;
  onBack: () => void;
  records: HistoryRecord[];
  status: HistoryStatus;
  error: string | null;
  remove: (id: string) => void;
  clear: () => void;
  retry: () => void;
  reset: () => void;
  exportJson: () => string;
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '날짜 확인 불가' : new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

function HistoryEntry({ record, onRemove }: { record: HistoryRecord; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const sourceId = useId();
  const preview = Array.from(record.sourceText);
  const appliedIndex = record.candidates.findIndex(candidate => candidate.id === record.appliedCandidateId);
  const requirementLabels = { alternative: '다른 표현', polite: '더 정중하게', plain: '더 담백하게', meaning: '원래 뜻 유지', errors: '남은 오류 수정' };

  return <details className="history-entry" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="history-summary-title"><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time><span className="history-summary-count">후보 {record.candidates.length}개</span></span>
      <span className="history-preview">{preview.slice(0, 100).join('')}{preview.length > 100 ? '…' : ''}</span>
      <span className="history-apply-status">{appliedIndex >= 0 ? record.targetCandidate ? '다시 다듬은 후보 적용 기록 있음' : `당시 후보 ${appliedIndex + 1} 적용 기록 있음` : '적용 기록 없음'}</span>
    </summary>
    {expanded && <div className="history-entry-content">
      {record.parentRecordId && <p className="history-explanation-note">{record.targetCandidate ? '이전 후보 하나를 다시 다듬은 기록입니다.' : `이전 교정에 이어 ${record.phase === 'after_apply' ? '적용 후' : '적용 전'} 재교정한 기록입니다.`} 요청한 점: {record.requirement ? requirementLabels[record.requirement] : '선택 안 함'}.</p>}
      <h3 id={sourceId}>교정 요청 당시 원문</h3>
      <div className="history-source" role="region" aria-labelledby={sourceId} tabIndex={0}>{record.sourceText}</div>
      <p className="history-explanation-note">당시 받아 둔 교정 이유만 표시합니다. 이력 조회로 새 설명을 요청하지 않습니다. 적용 표시는 이 기록에서 마지막으로 적용한 후보이며, 현재 글에 그대로 남아 있다는 뜻은 아닙니다.</p>
      <div className="candidate-list">{record.candidates.map((candidate, index) => {
        const explanation = record.explanations.find(value => value.candidateId === candidate.id);
        return <div key={candidate.id}>
          {candidate.id === record.appliedCandidateId && <p className="history-candidate-status">당시 적용한 후보{record.appliedAt && <> · <time dateTime={record.appliedAt}>{formatDate(record.appliedAt)}</time></>}</p>}
          <CandidateCard candidate={candidate} source={record.sourceText} index={index} explanation={explanation} title={record.targetCandidate ? '다시 다듬은 후보' : undefined} />
          {!explanation && <p className="history-explanation-note history-missing-explanation">이 후보에 저장된 교정 이유가 없습니다.</p>}
        </div>;
      })}</div>
      <div className="history-entry-footer"><button type="button" className="secondary-button history-delete" onClick={() => onRemove(record.id)}>이 기록 삭제</button></div>
    </div>}
  </details>;
}

export function HistoryPanel({ hidden, onBack, records, status, error, remove: onRemove, clear: onClear, retry: onRetry, reset: onReset, exportJson: onExport }: HistoryPanelProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => {
    if (!hidden) backRef.current?.focus({ preventScroll: true });
  }, [hidden]);
  const storageProblem = status === 'memory-only' || status === 'error' || status === 'corrupt';
  const focusHeading = () => requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  const remove = (id: string) => {
    if (!window.confirm('이 교정 기록을 삭제할까요? 삭제한 기록은 되돌릴 수 없으며, 현재 작성 중인 글은 바뀌지 않습니다.')) return;
    onRemove(id);
    focusHeading();
  };
  const clear = () => {
    if (!window.confirm(`교정 이력 ${records.length}개를 모두 삭제할까요? 삭제한 기록은 되돌릴 수 없으며, 현재 작성 중인 글은 바뀌지 않습니다.`)) return;
    onClear();
    focusHeading();
  };
  const reset = () => {
    const preserveNotice = HISTORY_EXPORT_ENABLED ? '현재 목록이 필요하면 먼저 JSON으로 내보내세요.' : '필요한 내용은 먼저 복사해 보관해주세요.';
    if (!window.confirm(`읽지 못한 기존 저장 데이터와 현재 교정 이력을 초기화할까요? 삭제한 기록은 복구할 수 없습니다. ${preserveNotice}`)) return;
    onReset();
    focusHeading();
  };
  const download = () => {
    if (!HISTORY_EXPORT_ENABLED) return;
    setExportError(null);
    let url: string | null = null;
    let link: HTMLAnchorElement | null = null;
    try {
      const json = onExport();
      url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
      link = document.createElement('a');
      link.href = url;
      link.download = `writing-demo-history-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
    } catch {
      setExportError('교정 이력을 내보내지 못했습니다. 브라우저의 다운로드 설정을 확인하고 다시 시도해주세요.');
    } finally {
      link?.remove();
      if (url) { const downloadUrl = url; setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000); }
    }
  };

  return <section id="correction-history" className="history-panel" hidden={hidden} aria-labelledby={headingId}>
    <div className="history-heading">
      <div className="history-title"><button ref={backRef} type="button" className="history-back" aria-label="교정 문장으로 돌아가기" onClick={onBack}><Icon name="back" size={20} /></button><h2 id={headingId} ref={headingRef} tabIndex={-1}>교정 이력<span>{records.length}개</span></h2></div>
      <div className="history-actions">
        {HISTORY_EXPORT_ENABLED && <button type="button" className="secondary-button" disabled={!records.length || status === 'loading'} onClick={download}>JSON 내보내기</button>}
        <button type="button" className="secondary-button history-delete" disabled={!records.length || status === 'loading'} onClick={clear}>전체 삭제</button>
      </div>
    </div>
    <div className="history-scroll">
    <p className="history-notice">교정한 부분의 원문·후보·받아 둔 설명을 이 브라우저에 저장합니다. 다른 브라우저와 동기화되지 않으며 브라우저 데이터를 지우면 사라질 수 있습니다.{HISTORY_EXPORT_ENABLED && ' 내보낸 JSON에도 문장 내용이 포함되니 공유 전에 확인해주세요.'}</p>
    {storageProblem && <div className="history-storage-status" role="status" aria-live="polite">
      <p>{status === 'corrupt'
        ? '기존 교정 이력을 읽지 못해 자동 저장을 중단했습니다. 기존 저장 데이터는 그대로 두었습니다. 새 기록은 이 페이지를 닫거나 새로고침하면 사라질 수 있습니다.'
        : status === 'memory-only'
          ? `이 브라우저에서는 이력을 저장할 수 없어 현재 페이지에서만 보관합니다. 이 페이지를 닫거나 새로고침하기 전에 ${HISTORY_EXPORT_ENABLED ? '필요한 기록을 JSON으로 내보내세요.' : '필요한 내용을 직접 복사해 보관해주세요.'}`
          : `교정 이력의 변경 내용을 브라우저에 저장하지 못했습니다. 현재 페이지에는 남아 있습니다. ${HISTORY_EXPORT_ENABLED ? '이 페이지를 닫거나 새로고침하기 전에 JSON으로 내보내거나 다시 저장해주세요.' : '저장을 다시 시도해주세요. 이 페이지를 닫거나 새로고침하기 전에는 필요한 내용을 직접 복사해 보관해주세요.'}`}</p>
      {error && <p>{error}</p>}
      <div className="history-actions">
        {status !== 'corrupt' && <button type="button" className="secondary-button" onClick={onRetry}>저장 다시 시도</button>}
        {status === 'corrupt' && <button type="button" className="secondary-button history-delete" onClick={reset}>이력 저장소 초기화</button>}
      </div>
    </div>}
    <p className="history-feedback" role="status" aria-live="polite">{status === 'loading' ? '교정 이력을 불러오고 있습니다.' : status === 'saving' ? '교정 이력을 저장하고 있습니다.' : status === 'saved' && records.length ? '이 브라우저에 저장되었습니다.' : ''}</p>
    {HISTORY_EXPORT_ENABLED && exportError && <p className="history-storage-status" role="alert">{exportError}</p>}
    {records.length ? <div className="history-list">{records.map(record => <HistoryEntry key={record.id} record={record} onRemove={remove} />)}</div>
      : status !== 'loading' && <p className="history-empty">아직 표시할 교정 이력이 없습니다. 교정 결과를 받으면 여기에 기록됩니다.</p>}
    </div>
  </section>;
}
