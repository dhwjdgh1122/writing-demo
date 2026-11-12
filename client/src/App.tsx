import { useEffect, useReducer, useRef, useState } from 'react';
import { countCharacters, LIMITS, selectionProblem } from '../../shared/contracts';
import { editorReducer, initialState } from './state/editor';
import { requestCorrection } from './lib/api';
import { Icon } from './components/Icon';
import { CorrectionResults } from './components/CorrectionResults';

export default function App() {
  const [state, dispatch] = useReducer(editorReducer, initialState);
  const [connection, setConnection] = useState<'checking' | 'ready' | 'missing' | 'offline'>('checking');
  const [composing, setComposing] = useState(false);
  const compositionRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef<HTMLButtonElement>(null);

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
    requestCorrection({ requestId: request.requestId, sourceText: request.sourceText }, controller.signal)
      .then(value => dispatch({ type: 'success', value }))
      .catch(error => {
        if (!controller.signal.aborted || timedOut) dispatch({ type: 'failure', requestId: request.requestId, message: timedOut ? '응답 시간이 초과되었습니다. 다시 시도해주세요.' : error instanceof Error ? error.message : '교정 요청에 실패했습니다.' });
      }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [state.pending]);

  const captureSelection = () => {
    const editor = editorRef.current;
    if (!editor || compositionRef.current) return;
    dispatch({ type: 'select', start: editor.selectionStart, end: editor.selectionEnd });
  };
  const documentLength = countCharacters(state.text);
  const selectedLength = countCharacters(state.selection?.text ?? '');
  const problem = documentLength > LIMITS.document ? '원문은 20,000자 이내로 줄여주세요.' : selectionProblem(state.selection?.text);
  const disabled = Boolean(problem || state.pending || composing);
  const connectionText = { checking: '연결 확인 중', ready: 'AI 설정 확인됨', missing: 'AI 연결 대기', offline: '서버 연결 확인 필요' }[connection];
  const apply = (candidateId: string) => {
    dispatch({type: 'apply', candidateId});
    const nextState = editorReducer(state, {type: 'apply', candidateId})
    if (state.selectionRevision === nextState.selectionRevision)
      return
    editorRef.current?.focus();
    editorRef.current?.setSelectionRange(state.selection!.start, state.selection!.end);
    const isSuccess = document.execCommand('insertText', false, nextState.selection!.text);
    runRef.current?.focus();
  };

  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="/" aria-label="문장 교정 데모 처음으로"><span className="brand-mark"><Icon name="pen" size={21} /></span><span>문장 교정<span className="brand-demo">DEMO</span></span></a><span className="header-note">문장의 의도는 그대로, 표현은 더 명확하게.</span><span className={`connection-badge ${connection}`}><i />{connectionText}</span></header>
    <main>
      <section className="page-intro" aria-labelledby="page-title"><div><p className="eyebrow">WRITING WORKSPACE</p><h1 id="page-title">고치고 싶은 문장부터 선택하세요.</h1><p className="intro-description">원문에서 필요한 부분만 선택하고, 교정안의 차이를 비교해보세요.</p></div><div className="steps" aria-label="사용 순서"><span><b>01</b> 문장 선택</span><i /><span><b>02</b> 교정 실행</span><i /><span><b>03</b> 비교·적용</span></div></section>
      <div className="workspace">
        <section className="editor-panel panel" aria-labelledby="editor-heading">
          <div className="panel-heading"><div className="heading-with-icon"><Icon name="document" /><h2 id="editor-heading">원문 작업 공간</h2></div><span className="subtle-tag">자유롭게 작성</span></div>
          <div className="editor-body"><label htmlFor="source-editor" className="sr-only">원문 입력</label><textarea id="source-editor" ref={editorRef} value={state.text} onChange={e => dispatch({ type: 'edit', text: e.target.value })} onSelect={captureSelection} onMouseUp={captureSelection} onKeyUp={captureSelection} onCompositionStart={() => { compositionRef.current = true; setComposing(true); }} onCompositionEnd={() => { compositionRef.current = false; setComposing(false); }} placeholder={'이곳에 원문을 입력하거나 붙여넣으세요.\n\n교정하고 싶은 문장을 드래그하면\n오른쪽에 선택한 내용이 나타납니다.'} aria-describedby="editor-hint document-count" spellCheck={false} />
            <div className="editor-meta"><span id="editor-hint"><Icon name="select" size={16} />드래그한 부분만 교정합니다</span><span id="document-count" className={documentLength > LIMITS.document ? 'over-limit' : ''}>{documentLength.toLocaleString()}<span className="count-limit"> / 20,000자</span></span></div>
          </div>
          <div className="editor-footnote"><Icon name="info" size={16} /><span>작업 내용은 자동 저장되지 않습니다.</span></div>
        </section>

        <section className="correction-panel panel" aria-label="교정 패널">
          <div className="tool-header"><span className="active-tool"><Icon name="pen" size={18} />문장 다듬기</span><span className="tool-settings">한국어<span />일반 문장</span></div>
          <div className="selection-section"><div className="section-heading"><h2>선택한 문장</h2><span className={`selected-count ${selectedLength > LIMITS.selection ? 'over-limit' : ''}`}><strong>{selectedLength.toLocaleString()}</strong> / 1,000자</span></div>
            <div className={`selected-text ${state.selection ? 'has-selection' : ''}`} data-testid="selected-text">{state.selection ? state.selection.text : <span>아직 선택한 문장이 없습니다.</span>}</div>
            <div className="selection-actions"><button className="text-button" disabled={!state.selection} onClick={() => dispatch({ type: 'clear' })}><Icon name="close" size={14} />선택 해제</button><button ref={runRef} className="primary-button" disabled={disabled} aria-describedby="selection-help" onClick={() => dispatch({ type: 'start', requestId: crypto.randomUUID() })}>{state.pending ? <><span className="spinner" />교정 중</> : <>교정 실행<Icon name="arrow" size={17} /></>}</button></div>
            <p id="selection-help" className={problem && state.selection ? 'selection-help over-limit' : 'selection-help'}>{composing ? '문장 입력을 마치면 실행할 수 있습니다.' : problem ?? '선택한 내용을 확인한 후 실행해주세요.'}</p>
          </div>
          <div className="results-section" aria-busy={Boolean(state.pending)}><div className="section-heading"><h2>교정 문장</h2>{state.result && <span className="result-count">후보 {state.result.value.candidates.length}개</span>}</div>
            <div role="status" aria-live="polite" className="status-region">{state.pending && <p className="loading-message"><span className="spinner" />교정안을 만들고 있습니다.</p>}{state.error && <div className="error-message"><Icon name="info" size={18} /><p>{state.error}</p></div>}{state.notice && <p className="success-message"><Icon name="check" size={18} />{state.notice}</p>}</div>
            {state.result ? <CorrectionResults key={state.result.value.requestId} result={state.result.value} onApply={apply} /> : !state.pending && <div className="empty-result"><div className="empty-icon"><Icon name="document" size={31} /></div><h3>{state.selection ? '교정할 준비가 되었습니다' : '문장을 선택하면 시작됩니다'}</h3><p>{state.selection ? '위에서 교정을 실행하면\n후보를 비교하고 원문에 적용할 수 있습니다.' : '왼쪽 원문에서 고치고 싶은 부분을 선택한 뒤\n교정 실행 버튼을 눌러주세요.'}</p></div>}
          </div>
          {connection === 'missing' && <div className="setup-note"><Icon name="info" size={16} /><p>현재는 화면·선택 기능을 확인할 수 있습니다.<br /><strong>실제 교정은 AI 연결 후 사용할 수 있습니다.</strong></p></div>}
        </section>
      </div>
      <footer className="page-footer"><span>센틴스파이 데스크톱 사용 흐름을 참고한 독립 웹 데모</span><span>선택한 문장만 요청에 포함됩니다.</span></footer>
    </main>
  </div>;
}
