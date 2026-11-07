import { LIMITS, countCharacters, selectionProblem, type CorrectionResult } from '../../../shared/contracts';

export type Selection = { start: number; end: number; text: string; revision: number };
export type Snapshot = { requestId: string; documentRevision: number; selectionRevision: number; start: number; end: number; sourceText: string };
export type EditorState = {
  text: string; revision: number; selectionRevision: number; selection: Selection | null;
  pending: Snapshot | null; result: { snapshot: Snapshot; value: CorrectionResult } | null;
  error: string | null; notice: string | null;
};
export const initialState: EditorState = { text: '', revision: 0, selectionRevision: 0, selection: null, pending: null, result: null, error: null, notice: null };
export type Action =
  | { type: 'edit'; text: string }
  | { type: 'select'; start: number; end: number }
  | { type: 'clear' }
  | { type: 'start'; requestId: string }
  | { type: 'success'; value: CorrectionResult }
  | { type: 'failure'; requestId: string; message: string }
  | { type: 'apply'; candidateId: string };

export function isCurrent(state: EditorState, snapshot: Snapshot): boolean {
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
      return { ...state, selectionRevision: revision, selection: { start: action.start, end: action.end, text: state.text.slice(action.start, action.end), revision }, pending: null, result: null, error: null, notice: null };
    }
    case 'clear': return { ...state, selection: null, selectionRevision: state.selectionRevision + 1, pending: null, result: null, error: null, notice: null };
    case 'start': {
      if (state.pending || !state.selection || selectionProblem(state.selection.text) || countCharacters(state.text) > LIMITS.document) return state;
      const { start, end, text, revision } = state.selection;
      return { ...state, pending: { requestId: action.requestId, documentRevision: state.revision, selectionRevision: revision, start, end, sourceText: text }, result: null, error: null, notice: null };
    }
    case 'success': {
      if (!state.pending || state.pending.requestId !== action.value.requestId || !isCurrent(state, state.pending)) return state;
      if (action.value.sourceText !== state.pending.sourceText) return { ...state, pending: null, error: '현재 선택과 일치하지 않는 결과입니다. 다시 실행해주세요.' };
      return { ...state, result: { snapshot: state.pending, value: action.value }, pending: null, error: null };
    }
    case 'failure': {
      if (!state.pending || state.pending.requestId !== action.requestId || !isCurrent(state, state.pending)) return state;
      return { ...state, pending: null, error: action.message };
    }
    case 'apply': {
      if (!state.result || !isCurrent(state, state.result.snapshot)) return state;
      const candidate = state.result.value.candidates.find(c => c.id === action.candidateId);
      if (!candidate || candidate.text === state.result.snapshot.sourceText) return state;
      const { start, end } = state.result.snapshot;
      const text = state.text.slice(0, start) + candidate.text + state.text.slice(end);
      if (countCharacters(text) > LIMITS.document) return { ...state, error: '적용하면 원문이 20,000자를 초과합니다. 원문을 줄인 후 다시 교정해주세요.' };
      const revision = state.selectionRevision + 1;
      return { ...initialState, text, revision: state.revision + 1, selectionRevision: revision,
        selection: { start, end: start + candidate.text.length, text: candidate.text, revision }, notice: '선택한 문장에 적용했습니다.' };
    }
  }
}
