import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { countCharacters, LIMITS, selectionProblem, type ExplanationResult, type RetryRequirement } from '../../shared/contracts';
import { editorReducer, initialState, type Action, type Snapshot } from './state/editor';
import { requestCorrection, requestFailureCode } from './lib/api';
import { Icon } from './components/Icon';
import { CorrectionResults, type ExplanationActivity } from './components/CorrectionResults';
import { SelectionConfirm } from './components/SelectionConfirm';
import { SelectionHighlight } from './components/SelectionHighlight';
import { selectionAnchor } from './lib/selectionAnchor';
import { useHistory } from './hooks/useHistory';
import { HistoryPanel } from './components/HistoryPanel';
import { RerunControls } from './components/RerunControls';
import { useActivity } from './hooks/useActivity';
import { ActivityPanel } from './components/ActivityPanel';
import { activityErrorCode } from './lib/activity';

const requestMetadata = (snapshot: Snapshot) => ({ requestId: snapshot.requestId,
  ...(snapshot.parentRequestId ? { parentRequestId: snapshot.parentRequestId, phase: snapshot.phase } : {}),
  ...(snapshot.retryContext?.requirement ? { requirement: snapshot.retryContext.requirement } : {}) });

export default function App() {
  const [state, editorDispatch] = useReducer(editorReducer, initialState);
  const history = useHistory();
  const activity = useActivity();
  const editorStateRef = useRef(initialState);
  // Queue persistence only for actions accepted by the editor. Keep side effects
  // outside React's reducer, which can run more than once in development.
  const dispatch = useCallback((action: Action) => {
    const previous = editorStateRef.current;
    const next = editorReducer(previous, action);
    editorStateRef.current = next;
    editorDispatch(action);
    if (action.type === 'start' && next.pending && next.pending !== previous.pending) {
      activity.record({ ...requestMetadata(next.pending), action: 'correction_requested' });
    }
    if (action.type === 'success' && next.result && next.result !== previous.result) {
      const snapshot = next.result.snapshot;
      history.enqueue({ type: 'add', record: { id: next.result.value.requestId, createdAt: new Date().toISOString(),
        sourceText: next.result.value.sourceText, candidates: next.result.value.candidates, explanations: [],
        appliedCandidateId: null, appliedAt: null,
        ...(snapshot.parentRequestId ? { parentRecordId: snapshot.parentRequestId, phase: snapshot.phase } : {}),
        ...(snapshot.retryContext?.requirement ? { requirement: snapshot.retryContext.requirement } : {}) } });
      activity.record({ ...requestMetadata(snapshot), action: 'correction_received' });
    }
    if (previous.pending && !next.pending && next !== previous) {
      if (action.type === 'failure' || (action.type === 'success' && !next.result)) {
        activity.record({ ...requestMetadata(previous.pending), action: 'correction_failed',
          errorCode: activityErrorCode(action.type === 'failure' ? action.errorCode : 'CLIENT_RESPONSE_INVALID') });
      } else if (action.type !== 'success') {
        activity.record({ ...requestMetadata(previous.pending), action: 'correction_cancelled' });
      }
    }
    if (action.type === 'apply' && previous.result && next.revision !== previous.revision) {
      history.enqueue({ type: 'apply', id: previous.result.value.requestId, candidateId: action.candidateId, at: new Date().toISOString() });
      activity.record({ ...requestMetadata(previous.result.snapshot), action: 'candidate_applied', candidateId: action.candidateId });
    }
    return next;
  }, [history.enqueue, activity.record]);
  const saveExplanations = useCallback((requestId: string, values: ExplanationResult[]) => {
    history.enqueue({ type: 'explanations', id: requestId, values });
  }, [history.enqueue]);
  const recordExplanationActivity = useCallback((event: ExplanationActivity) => activity.record(event), [activity.record]);
  const [connection, setConnection] = useState<'checking' | 'ready' | 'missing' | 'offline'>('checking');
  const [composing, setComposing] = useState(false);
  const compositionRef = useRef(false);
  const applyingRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [confirmation, setConfirmation] = useState<{ text: string; revision: number; selectionRevision: number } | null>(null);
  const draggingPointerRef = useRef<number | null>(null);

  const captureSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || compositionRef.current || applyingRef.current) return;
    dispatch({ type: 'select', start: editor.selectionStart, end: editor.selectionEnd });
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
  const openConfirmation = () => {
    if (disabled || !state.selection) return;
    setAnchor(null);
    setConfirmation({ text: state.selection.text, revision: state.revision, selectionRevision: state.selectionRevision });
  };
  const cancelConfirmation = () => {
    setConfirmation(null);
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor || !state.selection) return;
      const scrollTop = editor.scrollTop;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(state.selection.start, state.selection.end);
      editor.scrollTop = scrollTop;
      setAnchor(null);
    });
  };
  const confirmCorrection = () => {
    if (!confirmation || disabled || confirmation.revision !== state.revision || confirmation.selectionRevision !== state.selectionRevision) {
      cancelConfirmation();
      return;
    }
    setConfirmation(null);
    dispatch({ type: 'start', requestId: crypto.randomUUID() });
    // The invoking button is disabled/removed while requesting; keep keyboard focus in the editor.
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
  };
  const emptyHeading = state.notice ? '적용한 내용을 확인해주세요' : state.selection ? '교정할 준비가 되었습니다' : '문장을 선택하면 시작됩니다';
  const emptyDescription = state.notice
    ? '원문 작업 공간에서 바뀐 내용을 확인하세요.\n다른 문장을 다듬으려면 해당 부분을 선택해주세요.'
    : state.selection ? '교정 실행 버튼에서 선택한 문장을 확인하면\n교정을 시작할 수 있습니다.' : '원문에서 고치고 싶은 부분을 선택한 뒤\n교정 실행 버튼을 눌러주세요.';
  const connectionText = { checking: '연결 확인 중', ready: 'AI 설정 확인됨', missing: 'AI 연결 대기', offline: '서버 연결 확인 필요' }[connection];
  const rerun = (requirement?: RetryRequirement) => {
    if (disabled || !editorStateRef.current.rerun) return;
    setAnchor(null);
    dispatch({ type: 'start', requestId: crypto.randomUUID(), requirement });
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
  };
  const apply = (candidateId: string) => {
    const previous = editorStateRef.current;
    applyingRef.current = true;
    try {
      const nextState = dispatch({ type: 'apply', candidateId });
      if (previous.revision === nextState.revision || !previous.result || !nextState.selection) return;
      editorRef.current?.focus({ preventScroll: true });
      editorRef.current?.setSelectionRange(previous.result.snapshot.start, previous.result.snapshot.end);
      document.execCommand('insertText', false, nextState.selection.text);
      runRef.current?.focus();
    } finally { applyingRef.current = false; }
  };

  return <div className="app-shell" onPointerDown={event => {
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
              <div className="compact-actions"><button className="text-button" disabled={!state.selection} onClick={() => { setAnchor(null); dispatch({ type: 'clear' }); }}><Icon name="close" size={14} />선택 해제</button><button ref={runRef} className="secondary-button correction-fallback" disabled={disabled} aria-haspopup="dialog" aria-describedby="selection-help" onClick={openConfirmation}>{state.pending ? <><span className="spinner" />교정 중</> : <>교정 실행<Icon name="arrow" size={17} /></>}</button></div>
              <p id="selection-help" className={problem && state.selection ? 'selection-help over-limit' : 'selection-help'}>{composing ? '문장 입력을 마치면 실행할 수 있습니다.' : problem ?? (state.notice ? '원문에 반영된 내용을 확인해주세요.' : '선택한 내용을 확인한 후 실행해주세요.')}</p>
            </div>
          </div>
          <div className="editor-body"><label htmlFor="source-editor" className="sr-only">원문 입력</label><textarea id="source-editor" ref={editorRef} value={state.text} onChange={e => { setAnchor(null); dispatch({ type: 'edit', text: e.target.value }); }} onSelect={captureSelection} onPointerDown={event => { if (event.isPrimary && event.button === 0) { draggingPointerRef.current = event.pointerId; setAnchor(null); } }} onBlur={() => { draggingPointerRef.current = null; }} onKeyUp={captureSelection} onCompositionStart={() => { compositionRef.current = true; setComposing(true); setAnchor(null); }} onCompositionEnd={() => { compositionRef.current = false; setComposing(false); }} placeholder={'이곳에 원문을 입력하거나 붙여넣으세요.\n\n교정하고 싶은 문장을 드래그하면\n교정하기 버튼으로 선택한 내용을 확인하세요.'} aria-describedby="editor-hint document-count" spellCheck={false} />
            {confirmation && state.selection && confirmation.revision === state.revision && confirmation.selectionRevision === state.selectionRevision && <SelectionHighlight editor={editorRef.current} text={state.text} start={state.selection.start} end={state.selection.end} />}
            <div className="editor-meta"><span id="editor-hint"><Icon name="select" size={16} />드래그한 부분만 교정합니다</span><span id="document-count" className={documentLength > LIMITS.document ? 'over-limit' : ''}>전체 글 {documentLength.toLocaleString()}자<span className="count-limit"> · 최대 20,000자 입력 가능</span></span></div>
          </div>
          <div className="editor-footnote"><Icon name="info" size={16} /><span>선택한 부분의 원문·후보를 이 브라우저에 보관합니다. 작성 중인 글 전체는 새로고침 후 복원하지 않습니다.</span></div>
        </section>

        <section className="correction-panel panel" aria-label="교정 패널">
          <div className="results-section" aria-busy={Boolean(state.pending)}><div className="section-heading"><h2>교정 문장</h2>{state.result && <span className="result-count">후보 {state.result.value.candidates.length}개</span>}</div>
            <div role="status" aria-live="polite" className="status-region">{state.pending && <p className="loading-message"><span className="spinner" />교정안을 만들고 있습니다.</p>}{state.error && <div className="error-message"><Icon name="info" size={18} /><p>{state.error}</p></div>}{state.notice && <p className="success-message"><Icon name="check" size={18} />{state.notice}</p>}</div>
            {state.result ? <CorrectionResults key={state.result.value.requestId} result={state.result.value} onApply={apply} onExplanationResults={saveExplanations}
              activityContext={requestMetadata(state.result.snapshot)} onActivity={recordExplanationActivity} /> : !state.pending && <div className="empty-result"><div className="empty-icon"><Icon name="document" size={31} /></div><h3>{emptyHeading}</h3><p>{emptyDescription}</p></div>}
          </div>
          {state.rerun && <RerunControls key={`${state.rerun.parentRequestId}-${state.rerun.phase}`} phase={state.rerun.phase}
            disabled={disabled} pending={Boolean(state.pending)} problem={problem} onRun={rerun} />}
          {connection === 'missing' && <div className="setup-note"><Icon name="info" size={16} /><p>현재는 화면·선택 기능을 확인할 수 있습니다.<br /><strong>실제 교정은 AI 연결 후 사용할 수 있습니다.</strong></p></div>}
        </section>
      </div>
      <HistoryPanel {...history} />
      <ActivityPanel activity={activity} historyRecords={history.records} />
      <footer className="page-footer"><span>센틴스파이 데스크톱 사용 흐름을 참고한 독립 웹 데모</span><span>교정에는 선택한 문장만 사용하며, 요구를 선택한 재교정에는 이전 선택 원문·후보도 전달합니다.</span></footer>
    </main>
    {anchor && !disabled && !confirmation && <button className="floating-correction" style={anchor} aria-haspopup="dialog" onPointerDown={event => event.preventDefault()} onClick={openConfirmation}>교정하기 <Icon name="arrow" size={16} /></button>}
    {confirmation && <SelectionConfirm text={confirmation.text} count={countCharacters(confirmation.text)} onCancel={cancelConfirmation} onConfirm={confirmCorrection} />}
  </div>;
}
