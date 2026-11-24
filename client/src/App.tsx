import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { countCharacters, LIMITS, selectionProblem, type ExplanationResult, type RetryRequirement } from '../../shared/contracts';
import { editorReducer, initialState, type Action, type Snapshot } from './state/editor';
import { requestCorrection, requestFailureCode } from './lib/api';
import { Icon } from './components/Icon';
import { CorrectionResults, type ExplanationActivity, type ReadingState } from './components/CorrectionResults';
import { selectionAnchor } from './lib/selectionAnchor';
import { revealTextRange } from './lib/revealTextRange';
import { useHistory } from './hooks/useHistory';
import { HistoryPanel } from './components/HistoryPanel';
import { RerunControls, type RerunSelection } from './components/RerunControls';
import { useActivity, type ActivityApi } from './hooks/useActivity';
import { ActivityPanel } from './components/ActivityPanel';
import { activityErrorCode } from './lib/activity';
import { ACTIVITY_RECORDING_ENABLED } from './config/features';

const requestMetadata = (snapshot: Snapshot) => ({ requestId: snapshot.requestId,
  ...(snapshot.parentRequestId ? { parentRequestId: snapshot.parentRequestId, phase: snapshot.phase } : {}),
  ...(snapshot.targetCandidate ? { targetCandidateId: snapshot.targetCandidate.id } : {}),
  ...(snapshot.retryContext?.requirement ? { requirement: snapshot.retryContext.requirement } : {}) });
type RerunUI = { openId: string | null; requirement: RerunSelection; error: string | null };
type RerunOrigin = { requestId: string; candidateId: string; index: number; trigger: HTMLButtonElement };
type RerunPosition = { requestId: string; index: number; top: number };
const emptyRerunUI: RerunUI = { openId: null, requirement: '', error: null };

function rerunPosition(origin: RerunOrigin): RerunPosition | null {
  const entry = origin.trigger.closest('.rerun-entry');
  if (!entry || (document.activeElement !== document.body && !entry.contains(document.activeElement))) return null;
  const toggle = entry.querySelector<HTMLButtonElement>('.rerun-toggle');
  // The expanded choices can put the toggle above a narrow viewport. In that
  // case preserve the visible submit location instead. Do not follow users who
  // have scrolled away from both controls while waiting for the response.
  for (const anchor of [toggle, origin.trigger]) {
    if (!anchor?.getClientRects().length) continue;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) return { requestId: origin.requestId, index: origin.index, top: rect.top };
  }
  return null;
}

export default function App() {
  return ACTIVITY_RECORDING_ENABLED ? <WorkspaceWithActivity /> : <Workspace />;
}

function WorkspaceWithActivity() {
  const activity = useActivity();
  return <Workspace activity={activity} />;
}

function Workspace({ activity }: { activity?: ActivityApi }) {
  const [state, editorDispatch] = useReducer(editorReducer, initialState);
  const history = useHistory();
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const editorStateRef = useRef(initialState);
  const [rerunUI, setRerunUI] = useState<RerunUI>(emptyRerunUI);
  const rerunRequestRef = useRef<string | null>(null);
  const rerunOriginRef = useRef<RerunOrigin | null>(null);
  const rerunPositionRef = useRef<RerunPosition | null>(null);
  const correctionPanelRef = useRef<HTMLElement>(null);
  // A new generation replaces explanation data, but an explicit rerun keeps
  // the reading controls open. Ordinary correction/edit/selection starts fresh.
  const readingRef = useRef<ReadingState>({ explanationsOpen: false, comparisonsOpen: [] });
  const saveReadingState = useCallback((value: ReadingState) => { readingRef.current = value; }, []);
  useLayoutEffect(() => {
    const position = rerunPositionRef.current;
    rerunPositionRef.current = null;
    if (!position || state.result?.value.requestId !== position.requestId) return;
    const buttons = correctionPanelRef.current?.querySelectorAll<HTMLButtonElement>('.correction-view:not([hidden]) .candidate-card .rerun-toggle');
    const button = buttons?.[position.index];
    if (!button) return;
    // The old submit was removed with its replaced card. Never let focus itself
    // scroll to the first candidate or move to the middle of a different card.
    button.focus({ preventScroll: true });
    const rect = button.getBoundingClientRect();
    const top = Math.max(16, Math.min(position.top, window.innerHeight - rect.height - 16));
    window.scrollBy({ top: rect.top - top, behavior: 'instant' });
  }, [state.result]);
  // Queue persistence only for actions accepted by the editor. Keep side effects
  // outside React's reducer, which can run more than once in development.
  const dispatch = useCallback((action: Action) => {
    const previous = editorStateRef.current;
    const next = editorReducer(previous, action);
    if (!next.result) readingRef.current = { explanationsOpen: false, comparisonsOpen: [] };
    const wasRerun = Boolean(previous.pending && previous.pending.requestId === rerunRequestRef.current);
    const origin = rerunOriginRef.current;
    if (action.type === 'success' && next.result && next.result !== previous.result && origin && origin.requestId === previous.pending?.requestId) {
      rerunPositionRef.current = rerunPosition(origin);
    }
    editorStateRef.current = next;
    editorDispatch(action);
    if (next.rerun !== previous.rerun || (action.type === 'start' && next.pending !== previous.pending)) {
      setRerunUI(emptyRerunUI);
      rerunRequestRef.current = null;
      rerunOriginRef.current = null;
      if (action.type !== 'success') rerunPositionRef.current = null;
    }
    if ((action.type === 'start' || action.type === 'startRerun') && next.pending && next.pending !== previous.pending) {
      if (action.type === 'startRerun') {
        rerunRequestRef.current = next.pending.requestId;
        setRerunUI(current => ({ ...current, error: null }));
      }
      activity?.record({ ...requestMetadata(next.pending), action: 'correction_requested' });
    }
    if (action.type === 'success' && next.result && next.result !== previous.result) {
      const snapshot = next.result.snapshot;
      history.enqueue({ type: 'add', record: { id: action.value.requestId, createdAt: new Date().toISOString(),
        sourceText: action.value.sourceText, candidates: action.value.candidates, explanations: [],
        appliedCandidateId: null, appliedAt: null,
        ...(snapshot.targetCandidate ? { targetCandidate: snapshot.targetCandidate } : {}),
        ...(snapshot.parentRequestId ? { parentRecordId: snapshot.parentRequestId, phase: snapshot.phase } : {}),
        ...(snapshot.retryContext?.requirement ? { requirement: snapshot.retryContext.requirement } : {}) } });
      activity?.record({ ...requestMetadata(snapshot), action: 'correction_received' });
    }
    if (previous.pending && !next.pending && next !== previous) {
      if (action.type === 'failure' || (action.type === 'success' && next.result === previous.result)) {
        if (wasRerun) setRerunUI(current => ({ ...current, error: next.error }));
        activity?.record({ ...requestMetadata(previous.pending), action: 'correction_failed',
          errorCode: activityErrorCode(action.type === 'failure' ? action.errorCode : 'CLIENT_RESPONSE_INVALID') });
      } else if (action.type !== 'success') {
        activity?.record({ ...requestMetadata(previous.pending), action: 'correction_cancelled' });
      }
    }
    if (action.type === 'apply' && previous.result && next.revision !== previous.revision) {
      const origin = previous.result.origins[action.candidateId];
      history.enqueue({ type: 'apply', id: origin.requestId, candidateId: action.candidateId, at: new Date().toISOString() });
      activity?.record({ ...requestMetadata(origin), action: 'candidate_applied', candidateId: action.candidateId, attemptId: crypto.randomUUID() });
    }
    return next;
  }, [history.enqueue, activity?.record]);
  const saveExplanations = useCallback((requestId: string, values: ExplanationResult[]) => {
    history.enqueue({ type: 'explanations', id: requestId, values });
  }, [history.enqueue]);
  const recordExplanationActivity = useCallback((event: ExplanationActivity) => activity?.record(event), [activity?.record]);
  const [connection, setConnection] = useState<'checking' | 'ready' | 'missing' | 'offline'>('checking');
  const [composing, setComposing] = useState(false);
  const compositionRef = useRef(false);
  const applyingRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const appliedSelectionRef = useRef<{ revision: number; start: number; end: number } | null>(null);
  const [appliedHighlight, setAppliedHighlight] = useState<number | null>(null);
  const runRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const draggingPointerRef = useRef<number | null>(null);

  useEffect(() => {
    if (appliedHighlight === null) return;
    const timer = window.setTimeout(() => setAppliedHighlight(null), 2400);
    return () => window.clearTimeout(timer);
  }, [appliedHighlight]);

  const clearAppliedHighlight = () => {
    appliedSelectionRef.current = null;
    setAppliedHighlight(null);
  };

  const captureSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || compositionRef.current || applyingRef.current) return;
    dispatch({ type: 'select', start: editor.selectionStart, end: editor.selectionEnd });
    const applied = appliedSelectionRef.current;
    // The selection is feedback for applying, not a new request to show the
    // floating correction button over the text the user is trying to inspect.
    if (applied?.revision === editorStateRef.current.revision && applied.start === editor.selectionStart && applied.end === editor.selectionEnd) return;
    if (draggingPointerRef.current === null) setAnchor(selectionAnchor(editor));
  }, [dispatch]);

  useEffect(() => {
    // Text selection may end outside the textarea without blurring it.
    const finishDrag = (event: PointerEvent) => {
      if (event.pointerId !== draggingPointerRef.current) return;
      draggingPointerRef.current = null;
      captureSelection();
    };
    const cancelDrag = (event: PointerEvent) => {
      if (event.pointerId !== draggingPointerRef.current) return;
      draggingPointerRef.current = null;
      setAnchor(null);
    };
    const blur = () => { draggingPointerRef.current = null; setAnchor(null); };
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', cancelDrag);
      window.removeEventListener('blur', blur);
    };
  }, [captureSelection]);

  useEffect(() => {
    const hide = () => setAnchor(null);
    // Hide stale floating coordinates on scrolling/resizing; the fixed control remains available.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error('offline');
      const health = await r.json();
      if (typeof health.modelConfigured !== 'boolean') throw new Error('invalid');
      setConnection(health.modelConfigured ? 'ready' : 'missing');
    }).catch(() => { if (!controller.signal.aborted) setConnection('offline'); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!state.pending) return;
    const request = state.pending;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, LIMITS.timeout + 5_000);
    requestCorrection({ requestId: request.requestId, sourceText: request.sourceText,
      ...(request.targetCandidate ? { targetCandidate: request.targetCandidate } : {}),
      ...(request.retryContext ? { retryContext: request.retryContext } : {}) }, controller.signal)
      .then(value => dispatch({ type: 'success', value }))
      .catch(error => {
        if (!controller.signal.aborted || timedOut) dispatch({ type: 'failure', requestId: request.requestId,
          errorCode: timedOut ? 'CLIENT_TIMEOUT' : requestFailureCode(error),
          message: timedOut ? '응답 시간이 초과되었습니다. 다시 시도해주세요.' : error instanceof Error ? error.message : '교정 요청에 실패했습니다.' });
      }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [state.pending, dispatch]);

  const documentLength = countCharacters(state.text);
  const selectedLength = countCharacters(state.selection?.text ?? '');
  const problem = documentLength > LIMITS.document ? '원문은 20,000자 이내로 줄여주세요.' : selectionProblem(state.selection?.text);
  const disabled = Boolean(problem || state.pending || composing);
  const startCorrection = () => {
    // Both entry points use the saved selection. The reducer validates its
    // current range and limits; the ref also guards clicks before React renders.
    if (disabled || compositionRef.current || editorStateRef.current.pending) return;
    setAnchor(null);
    const next = dispatch({ type: 'start', requestId: crypto.randomUUID() });
    if (!next.pending) return;
    // The invoking button is disabled/removed while requesting; keep keyboard focus in the editor.
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
  };
  const emptyHeading = state.notice ? '적용한 내용을 확인해주세요' : state.selection ? '교정할 준비가 되었습니다' : '문장을 선택하면 시작됩니다';
  const emptyDescription = state.notice
    ? '원문 작업 공간에서 바뀐 내용을 확인하세요.\n다른 문장을 다듬으려면 해당 부분을 선택해주세요.'
    : state.selection ? '교정 실행 버튼을 누르면\n선택한 문장을 바로 교정합니다.' : '원문에서 고치고 싶은 부분을 선택한 뒤\n교정 실행 버튼을 눌러주세요.';
  const connectionText = { checking: '연결 확인 중', ready: 'AI 설정 확인됨', missing: 'AI 연결 대기', offline: '서버 연결 확인 필요' }[connection];
  const rerun = (id: string, trigger: HTMLButtonElement, requirement?: RetryRequirement) => {
    if (disabled || editorStateRef.current.pending || !editorStateRef.current.rerun) return;
    setAnchor(null);
    const requestId = crypto.randomUUID();
    rerunOriginRef.current = { requestId, candidateId: id, trigger,
      index: Math.max(0, editorStateRef.current.result?.value.candidates.findIndex(candidate => candidate.id === id) ?? 0) };
    dispatch({ type: 'startRerun', requestId, requirement, candidateId: id });
  };
  const renderRerun = (id: string) => state.rerun && <RerunControls phase={state.rerun.phase}
    unavailable={state.rerun.phase === 'after_apply' && state.result?.appliedCandidateId !== id}
    restoreFocusOnError={rerunOriginRef.current?.candidateId === id}
    open={rerunUI.openId === id} requirement={rerunUI.requirement} disabled={disabled} pending={Boolean(state.pending)}
    problem={problem} error={rerunUI.error}
    onToggle={() => setRerunUI(current => ({ ...current, openId: current.openId === id ? null : id }))}
    onChange={requirement => setRerunUI(current => ({ ...current, requirement }))}
    onRun={trigger => rerun(id, trigger, rerunUI.requirement || undefined)} />;
  const closeHistory = () => {
    setHistoryOpen(false);
    requestAnimationFrame(() => historyButtonRef.current?.focus({ preventScroll: true }));
  };
  const apply = (candidateId: string) => {
    const previous = editorStateRef.current;
    applyingRef.current = true;
    try {
      const nextState = dispatch({ type: 'apply', candidateId });
      if (previous.revision === nextState.revision || !previous.result || !nextState.selection) return;
      editorRef.current?.focus({ preventScroll: true });
      editorRef.current?.setSelectionRange(previous.result.application.start, previous.result.application.end);
      document.execCommand('insertText', false, nextState.selection.text);
      setAnchor(null);
      appliedSelectionRef.current = { revision: nextState.revision, start: nextState.selection.start, end: nextState.selection.end };
      setAppliedHighlight(nextState.revision);
      requestAnimationFrame(() => {
        const editor = editorRef.current;
        const selection = appliedSelectionRef.current;
        if (!editor || !selection || editorStateRef.current.revision !== nextState.revision
          || editorStateRef.current.selection !== nextState.selection) return;
        applyingRef.current = true;
        try {
          editor.focus({ preventScroll: true });
          editor.setSelectionRange(selection.start, selection.end, 'backward');
          // Only the independently sticky toolbar can cover the input. On wide
          // screens it flows inside the sticky panel instead of overlapping it.
          const controls = editor.closest('.editor-panel')?.querySelector<HTMLElement>('.editor-controls');
          const controlsStyle = controls && getComputedStyle(controls);
          const viewportTop = controls && controlsStyle?.position === 'sticky'
            ? controls.offsetHeight + (parseFloat(controlsStyle.top) || 0) + 16 : 16;
          revealTextRange(editor, selection.start, selection.end, viewportTop);
        } finally { applyingRef.current = false; }
      });
    } finally { applyingRef.current = false; }
  };

  return <div className="app-shell" onPointerDown={event => {
    if (event.target instanceof Node && !rerunOriginRef.current?.trigger.closest('.rerun-entry')?.contains(event.target)) rerunOriginRef.current = null;
    if (!(event.target instanceof Element) || (!event.target.closest('#source-editor') && !event.target.closest('.floating-correction'))) setAnchor(null);
  }}>
    <header className="site-header"><a className="brand" href="/" aria-label="문장 교정 데모 처음으로"><span className="brand-mark"><Icon name="pen" size={21} /></span><span>문장 교정<span className="brand-demo">DEMO</span></span></a><span className="header-note">문장의 의도는 그대로, 표현은 더 명확하게.</span><span className={`connection-badge ${connection}`}><i />{connectionText}</span></header>
    <main>
      <section className="page-intro" aria-labelledby="page-title"><div><p className="eyebrow">WRITING WORKSPACE</p><h1 id="page-title">고치고 싶은 문장부터 선택하세요.</h1><p className="intro-description">원문에서 필요한 부분만 선택하고, 교정안의 차이를 비교해보세요.</p></div><div className="steps" aria-label="사용 순서"><span><b>01</b> 문장 선택</span><i /><span><b>02</b> 교정 실행</span><i /><span><b>03</b> 비교·적용</span></div></section>
      <div className="workspace">
        <section className="editor-panel panel" aria-labelledby="editor-heading">
          <div className="editor-controls">
            <div className="panel-heading"><div className="heading-with-icon"><Icon name="document" /><h2 id="editor-heading">원문 작업 공간</h2></div><span className="subtle-tag">한국어 · 일반 문장</span></div>
            <div className="compact-selection" aria-label="선택 및 교정 실행">
              <span className={selectedLength > LIMITS.selection ? 'over-limit' : ''}>선택한 글 {selectedLength.toLocaleString()}자 · 최대 1,000자까지 교정할 수 있어요</span>
              <div className="compact-actions"><button className="text-button" disabled={!state.selection} onClick={() => { setAnchor(null); dispatch({ type: 'clear' }); }}><Icon name="close" size={14} />선택 해제</button><button ref={runRef} className="secondary-button correction-fallback" disabled={disabled} aria-describedby="selection-help" onClick={startCorrection}>{state.pending ? <><span className="spinner" />교정 중</> : <>교정 실행<Icon name="arrow" size={17} /></>}</button></div>
              <p id="selection-help" className={problem && state.selection ? 'selection-help over-limit' : 'selection-help'}>{composing ? '문장 입력을 마치면 실행할 수 있습니다.' : problem ?? (state.notice ? '원문에 반영된 내용을 확인해주세요.' : '선택한 내용을 확인한 후 실행해주세요.')}</p>
            </div>
          </div>
          <div className="editor-body"><label htmlFor="source-editor" className="sr-only">원문 입력</label><textarea id="source-editor" ref={editorRef} value={state.text} className={appliedHighlight === state.revision ? 'applied-highlight' : undefined} onChange={e => { setAnchor(null); dispatch({ type: 'edit', text: e.target.value }); }} onSelect={captureSelection} onPointerDown={event => { clearAppliedHighlight(); if (event.isPrimary && event.button === 0) { draggingPointerRef.current = event.pointerId; setAnchor(null); } }} onBlur={() => { draggingPointerRef.current = null; }} onKeyDown={clearAppliedHighlight} onKeyUp={captureSelection} onCompositionStart={() => { clearAppliedHighlight(); compositionRef.current = true; setComposing(true); setAnchor(null); }} onCompositionEnd={() => { compositionRef.current = false; setComposing(false); }} placeholder={'이곳에 원문을 입력하거나 붙여넣으세요.\n\n교정하고 싶은 문장을 드래그한 뒤\n교정하기 버튼을 누르면 바로 교정합니다.'} aria-describedby="editor-hint document-count" spellCheck={false} />
            <div className="editor-meta"><span id="editor-hint"><Icon name="select" size={16} />드래그한 부분만 교정합니다</span><span id="document-count" className={documentLength > LIMITS.document ? 'over-limit' : ''}>전체 글 {documentLength.toLocaleString()}자<span className="count-limit"> · 최대 20,000자 입력 가능</span></span></div>
          </div>
          <div className="editor-footnote"><Icon name="info" size={16} /><span>선택한 부분의 원문·후보를 이 브라우저에 보관합니다. 작성 중인 글 전체는 새로고침 후 복원하지 않습니다.</span></div>
        </section>

        <section ref={correctionPanelRef} className="correction-panel panel" aria-label="교정 패널">
          {/* Keep both views mounted so navigation preserves comparisons, explanations and in-flight requests. */}
          <div className="correction-view" hidden={historyOpen}>
          <div className="results-section" aria-busy={Boolean(state.pending)}><div className="section-heading"><h2>교정 문장</h2><button ref={historyButtonRef} type="button" className="panel-action history-toggle" aria-controls="correction-history" onClick={() => setHistoryOpen(true)}><Icon name="history" size={18} /><span>교정 이력</span></button></div>
            {(['memory-only', 'error', 'corrupt'] as const).some(status => status === history.status) && <p className="history-save-warning" role="status">교정 이력 자동 저장에 문제가 있습니다. 교정 이력에서 저장 상태를 확인해주세요.</p>}
            <div role="status" aria-live="polite" className="status-region">{state.pending && <p className="loading-message"><span className="spinner" />{state.pending.targetCandidate ? '선택한 후보를 다시 다듬고 있습니다. 다른 후보는 유지됩니다.' : state.result ? '새 교정안을 만들고 있습니다. 아래 후보는 이전 결과입니다.' : '교정안을 만들고 있습니다.'}</p>}{state.error && state.error !== rerunUI.error && <div className="error-message"><Icon name="info" size={18} /><p>{state.error}</p></div>}</div>
            {state.notice && <div className="applied-state"><p className="success-message" role="status"><Icon name="check" size={18} />{state.notice}</p><p className="applied-comparison-note">원문 비교와 교정 이유는 이 후보를 생성할 당시 원문을 기준으로 합니다.</p></div>}
            {state.result ? <CorrectionResults key={state.result.batchId} result={state.result.value} candidateOrigins={state.result.origins} onApply={apply} onExplanationResults={saveExplanations}
              appliedCandidateId={state.result.appliedCandidateId} currentText={state.result.application.sourceText} initialReading={readingRef.current} onReadingChange={saveReadingState}
              activityContext={activity ? requestMetadata(state.result.snapshot) : undefined} onActivity={activity ? recordExplanationActivity : undefined} disabled={Boolean(state.pending)} renderRerun={renderRerun} /> : !state.pending && <div className="empty-result"><div className="empty-icon"><Icon name="document" size={31} /></div><h3>{emptyHeading}</h3><p>{emptyDescription}</p></div>}
          </div>
          {connection === 'missing' && <div className="setup-note"><Icon name="info" size={16} /><p>현재는 화면·선택 기능을 확인할 수 있습니다.<br /><strong>실제 교정은 AI 연결 후 사용할 수 있습니다.</strong></p></div>}
          </div>
          <HistoryPanel {...history} hidden={!historyOpen} onBack={closeHistory} />
        </section>
      </div>
      {activity && <ActivityPanel activity={activity} historyRecords={history.records} />}
      <footer className="page-footer"><span>센틴스파이 데스크톱 사용 흐름을 참고한 독립 웹 데모</span><span>교정에는 선택한 문장을 사용하며, 후보별 재교정에는 해당 후보와 원문을 함께 전달합니다.</span></footer>
    </main>
    {anchor && !disabled && <button className="floating-correction" style={anchor} onPointerDown={event => event.preventDefault()} onClick={startCorrection}>교정하기 <Icon name="arrow" size={16} /></button>}
  </div>;
}
