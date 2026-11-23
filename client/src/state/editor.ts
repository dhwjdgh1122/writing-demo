import { LIMITS, countCharacters, selectionProblem, retryContextsMatch, targetCandidatesMatch, type CorrectionResult, type Candidate, type RetryContext, type RetryRequirement } from '../../../shared/contracts';

export type Selection = { start: number; end: number; text: string; revision: number };
export type Rerun = { parentRequestId: string; phase: 'before_apply' | 'after_apply'; previousSourceText: string; previousCandidates: Candidate[] };
export type Snapshot = { requestId: string; documentRevision: number; selectionRevision: number; start: number; end: number; sourceText: string;
  retryContext?: RetryContext; targetCandidate?: Candidate; parentRequestId?: string; phase?: Rerun['phase'] };
type ApplicationRange = Pick<Snapshot, 'documentRevision' | 'selectionRevision' | 'start' | 'end' | 'sourceText'>;
export type EditorResult = { snapshot: Snapshot; value: CorrectionResult; batchId: string; origins: Record<string, Snapshot>;
  application: ApplicationRange; appliedCandidateId: string | null };
export type EditorState = {
  text: string; revision: number; selectionRevision: number; selection: Selection | null;
  pending: Snapshot | null; result: EditorResult | null; rerun: Rerun | null;
  error: string | null; notice: string | null;
};
export const initialState: EditorState = { text: '', revision: 0, selectionRevision: 0, selection: null, pending: null, result: null, rerun: null, error: null, notice: null };
export type Action =
  | { type: 'edit'; text: string }
  | { type: 'select'; start: number; end: number }
  | { type: 'clear' }
  | { type: 'start'; requestId: string; requirement?: RetryRequirement }
  | { type: 'startRerun'; requestId: string; requirement?: RetryRequirement; candidateId?: string }
  | { type: 'success'; value: CorrectionResult }
  | { type: 'failure'; requestId: string; message: string; errorCode?: string }
  | { type: 'apply'; candidateId: string };

export function isCurrent(state: EditorState, snapshot: ApplicationRange): boolean {
  return snapshot.documentRevision === state.revision && snapshot.selectionRevision === state.selection?.revision
    && snapshot.start === state.selection.start && snapshot.end === state.selection.end
    && state.text.slice(snapshot.start, snapshot.end) === snapshot.sourceText;
}

export function editorReducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'edit': {
      if (state.text === action.text) return state;
      // Keep an oversized paste visible instead of silently truncating or losing it.
      return { ...initialState, text: action.text, revision: state.revision + 1, selectionRevision: state.selectionRevision + 1,
        error: countCharacters(action.text) > LIMITS.document ? '원문은 20,000자 이내로 줄여주세요. 내용을 줄이면 교정할 수 있습니다.' : null };
    }
    case 'select': {
      if (action.start === action.end) return state;
      if (action.start < 0 || action.end > state.text.length || action.start > action.end) return state;
      if (state.selection?.start === action.start && state.selection.end === action.end) return state;
      const revision = state.selectionRevision + 1;
      return { ...state, selectionRevision: revision, selection: { start: action.start, end: action.end, text: state.text.slice(action.start, action.end), revision }, pending: null, result: null, rerun: null, error: null, notice: null };
    }
    case 'clear': return { ...state, selection: null, selectionRevision: state.selectionRevision + 1, pending: null, result: null, rerun: null, error: null, notice: null };
    case 'start':
    case 'startRerun': {
      if (state.pending || !state.selection || selectionProblem(state.selection.text) || countCharacters(state.text) > LIMITS.document
        || ((action.type === 'startRerun' || action.requirement) && !state.rerun)) return state;
      const { start, end, text, revision } = state.selection;
      const predecessor = state.rerun;
      const afterApply = predecessor?.phase === 'after_apply';
      if (action.type === 'startRerun' && action.candidateId && afterApply && action.candidateId !== state.result?.appliedCandidateId) return state;
      const target = action.type === 'startRerun' && action.candidateId && !afterApply
        ? state.result?.value.candidates.find(candidate => candidate.id === action.candidateId) : undefined;
      if (action.type === 'startRerun' && action.candidateId && ((!afterApply && !target) || !state.result || !isCurrent(state, state.result.application))) return state;
      const parentRequestId = target ? state.result!.origins[target.id].requestId : predecessor?.parentRequestId;
      // A rerun keeps the last successful batch mounted until a valid replacement arrives.
      // Starting an ordinary correction retains its existing clear-before-loading behavior.
      const retainResult = action.type === 'startRerun' && state.result && isCurrent(state, state.result.application);
      return { ...state, pending: { requestId: action.requestId, documentRevision: state.revision, selectionRevision: revision, start, end, sourceText: text,
        ...(predecessor ? { parentRequestId, phase: predecessor.phase } : {}),
        ...(target ? { targetCandidate: target } : {}),
        ...(predecessor && action.requirement ? { retryContext: { requirement: action.requirement,
          previousSourceText: target ? text : predecessor.previousSourceText, previousCandidates: target ? [target] : predecessor.previousCandidates } } : {}),
      }, result: retainResult ? state.result : null, error: null, notice: action.type === 'startRerun' ? state.notice : null };
    }
    case 'success': {
      if (!state.pending || state.pending.requestId !== action.value.requestId || !isCurrent(state, state.pending)) return state;
      const target = state.pending.targetCandidate;
      if (action.value.sourceText !== state.pending.sourceText || !retryContextsMatch(action.value.retryContext, state.pending.retryContext)
        || !targetCandidatesMatch(action.value.targetCandidate, target)
        || (target && (action.value.candidates.length !== 1 || !state.result
          || !state.result.value.candidates.some(candidate => targetCandidatesMatch(candidate, target))
          || state.result.value.candidates.some(candidate => candidate.id === action.value.candidates[0].id)))) {
        return { ...state, pending: null, error: '현재 선택과 일치하지 않는 결과입니다. 다시 실행해주세요.' };
      }
      const candidates = target ? state.result!.value.candidates.map(candidate => candidate.id === target.id ? action.value.candidates[0] : candidate) : action.value.candidates;
      const origins: Record<string, Snapshot> = Object.fromEntries([
        ...(target ? Object.entries(state.result!.origins).filter(([id]) => id !== target.id) : []),
        ...action.value.candidates.map(candidate => [candidate.id, state.pending]),
      ]);
      return { ...state, result: { snapshot: state.pending, application: state.pending, appliedCandidateId: null, value: { ...action.value, candidates },
        batchId: target ? state.result!.batchId : action.value.requestId, origins }, pending: null, error: null, notice: null,
        rerun: { parentRequestId: action.value.requestId, phase: 'before_apply', previousSourceText: action.value.sourceText, previousCandidates: candidates } };
    }
    case 'failure': {
      if (!state.pending || state.pending.requestId !== action.requestId || !isCurrent(state, state.pending)) return state;
      return { ...state, pending: null, error: action.message };
    }
    case 'apply': {
      if (state.pending || !state.result || !isCurrent(state, state.result.application)) return state;
      const candidate = state.result.value.candidates.find(c => c.id === action.candidateId);
      if (!candidate || candidate.text === state.result.application.sourceText) return state;
      const { start, end } = state.result.application;
      const text = state.text.slice(0, start) + candidate.text + state.text.slice(end);
      if (countCharacters(text) > LIMITS.document) return { ...state, error: '적용하면 원문이 20,000자를 초과합니다. 원문을 줄인 후 다시 교정해주세요.' };
      const revision = state.selectionRevision + 1;
      // Keep generation evidence immutable. Only the current replacement range
      // advances when a different-length candidate is applied to the document.
      return { ...state, text, revision: state.revision + 1, selectionRevision: revision,
        result: { ...state.result, appliedCandidateId: candidate.id,
          application: { start, end: start + candidate.text.length, sourceText: candidate.text,
            documentRevision: state.revision + 1, selectionRevision: revision } },
        selection: { start, end: start + candidate.text.length, text: candidate.text, revision }, error: null, notice: '선택한 문장에 적용했습니다. 다른 후보와 계속 비교할 수 있습니다.',
        rerun: { parentRequestId: state.result.origins[candidate.id].requestId, phase: 'after_apply', previousSourceText: state.result.value.sourceText, previousCandidates: [candidate] } };
    }
  }
}
