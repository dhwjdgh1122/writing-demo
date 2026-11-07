import { correctionOutputSchema, explanationOutputSchema, explanationsMatch, type ExplanationInput, type CorrectionInput } from '../../../shared/contracts';

export async function requestExplanations(input: ExplanationInput, signal: AbortSignal) {
  const response = await fetch('/api/explanations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data?.error?.message === 'string' ? data.error.message : '설명을 불러오지 못했습니다. 다시 시도해주세요.');
  const parsed = explanationOutputSchema.safeParse(data);
  if (!parsed.success || parsed.data.requestId !== input.requestId || parsed.data.sourceText !== input.sourceText
    || parsed.data.candidates.length !== input.candidates.length
    || !input.candidates.every(c => parsed.data.candidates.some(p => p.id === c.id && p.text === c.text))
    || !explanationsMatch(input.candidates, parsed.data.explanations)) throw new Error('현재 후보와 일치하는 설명을 받지 못했습니다. 다시 시도해주세요.');
  return parsed.data.explanations;
}

export async function requestCorrection(input: CorrectionInput, signal: AbortSignal) {
  const response = await fetch('/api/corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data?.error?.message === 'string' ? data.error.message : '서버 요청에 실패했습니다. 다시 시도해주세요.');
  const parsed = correctionOutputSchema.safeParse(data);
  if (!parsed.success || parsed.data.requestId !== input.requestId || parsed.data.sourceText !== input.sourceText) throw new Error('현재 선택과 일치하는 교정 결과를 받지 못했습니다. 다시 실행해주세요.');
  return parsed.data;
}
