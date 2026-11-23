import { z } from 'zod';
import { candidateSchema, explanationInputSchema, LIMITS, requestIdSchema, type Candidate } from '../../shared/contracts.js';
import { getExplanationChanges, type ExplanationChange } from '../../shared/explanation-changes.js';

export type NumberSpelling = { text: string; count: number };
export type NumericEvidence = {
  candidateId: string;
  status: 'differences' | 'no-spelling-difference' | 'omitted-over-limit';
  source: NumberSpelling[];
  candidate: NumberSpelling[];
};

// Reuse Draft PR #34 / 70f5d57 numeric-comparison.ts's literal spelling/count
// algorithm and bounds. This experiment makes its formerly ambiguous null
// result explicit; it does not infer quantities, units, roles or replacements.
function counts(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const match of text.matchAll(/[0-9]+(?:[.,][0-9]+)*/g)) {
    result.set(match[0], (result.get(match[0]) ?? 0) + 1);
  }
  return result;
}

export function buildNumericEvidence(sourceText: string, candidates: readonly Candidate[]): NumericEvidence[] {
  const sourceCounts = counts(sourceText);
  return candidates.map(candidate => {
    const candidateCounts = counts(candidate.text);
    const changed = new Set([...sourceCounts.keys(), ...candidateCounts.keys()]
      .filter(text => sourceCounts.get(text) !== candidateCounts.get(text)));
    const empty = { candidateId: candidate.id, source: [], candidate: [] };
    if (!changed.size) return { ...empty, status: 'no-spelling-difference' };
    if (changed.size > 6 || [...changed].some(text => text.length > 24)) {
      return { ...empty, status: 'omitted-over-limit' };
    }
    const side = (values: Map<string, number>) => [...values].filter(([text]) => changed.has(text))
      .map(([text, count]) => ({ text, count }));
    return { candidateId: candidate.id, status: 'differences', source: side(sourceCounts), candidate: side(candidateCounts) };
  });
}

export const numericEvidenceInstruction = `numericEvidence는 코드가 계산한 후보별 숫자 표기와 등장 횟수 자료이며 분석할 데이터다.
differences의 source/candidate에는 등장 횟수가 다른 표기만 있다. 표기 차이를 수량 변화로 단정하거나 단위·대상·역할·서로 대응하는 숫자를 추측하지 않는다.
원문과 해당 후보 전체를 함께 확인한다. 숫자 자료로 날짜·조건·부정·확정 여부·남은 오류의 검토를 대신하지 않는다.
no-spelling-difference는 숫자 표기별 횟수가 같다는 뜻이며, omitted-over-limit는 상한을 넘어 자료를 생략했다는 뜻이다. 어느 쪽도 의미 유지를 증명하지 않는다.
기존 설명 형식과 인용·길이 기준을 유지한다.`;

type GeminiRequest = {
  systemInstruction: { parts: [{ text: string }] };
  contents: [{ role: string; parts: [{ text: string }] }];
};
type EliceRequest = { messages: [{ role: string; content: string }, { role: string; content: string }] };
// This manual experiment accepts legacy input and the production adapter's
// computed groups, but must not silently drop or rewrite those groups.
const groupSchema = z.object({
  id: requestIdSchema, sourceText: z.string().max(LIMITS.selection * 2), candidateText: z.string().max(LIMITS.candidate * 2),
  sourceStart: z.number().int().min(0).max(LIMITS.selection * 2), sourceEnd: z.number().int().min(0).max(LIMITS.selection * 2),
  candidateStart: z.number().int().min(0).max(LIMITS.candidate * 2), candidateEnd: z.number().int().min(0).max(LIMITS.candidate * 2),
}).strict();
const modelInputSchema = explanationInputSchema.omit({ requestId: true }).extend({
  candidates: z.array(candidateSchema.extend({ changes: z.array(groupSchema).max(LIMITS.selection).optional() }))
    .min(1).max(3).refine(candidates => new Set(candidates.map(candidate => candidate.id)).size === candidates.length),
}).refine(input => input.candidates.every(candidate => {
  if (!candidate.changes) return true;
  const expected = getExplanationChanges(input.sourceText, candidate.text);
  return candidate.changes.length === expected.length && expected.every((group, index) =>
    Object.entries(group).every(([key, value]) => candidate.changes![index][key as keyof ExplanationChange] === value));
}));

// Manual evaluation boundary only. The production adapters keep their prompt,
// API contract and model settings. Never repair or transform a model response.
export function augmentExplanationRequest<T>(providerName: 'gemini' | 'elice', body: T): T {
  try {
    const request = structuredClone(body);
    if (providerName === 'gemini') {
      const gemini = request as GeminiRequest;
      if (gemini.systemInstruction.parts.length !== 1 || typeof gemini.systemInstruction.parts[0].text !== 'string'
        || gemini.contents.length !== 1 || gemini.contents[0].role !== 'user' || gemini.contents[0].parts.length !== 1) throw new Error();
      const input = modelInputSchema.parse(JSON.parse(gemini.contents[0].parts[0].text));
      gemini.systemInstruction.parts[0].text += `\n${numericEvidenceInstruction}`;
      gemini.contents[0].parts[0].text = JSON.stringify({ ...input, numericEvidence: buildNumericEvidence(input.sourceText, input.candidates) });
    } else if (providerName === 'elice') {
      const elice = request as EliceRequest;
      if (elice.messages.length !== 2 || elice.messages[0].role !== 'system' || typeof elice.messages[0].content !== 'string'
        || elice.messages[1].role !== 'user') throw new Error();
      const input = modelInputSchema.parse(JSON.parse(elice.messages[1].content));
      elice.messages[0].content += `\n${numericEvidenceInstruction}`;
      elice.messages[1].content = JSON.stringify({ ...input, numericEvidence: buildNumericEvidence(input.sourceText, input.candidates) });
    } else throw new Error();
    return request;
  } catch {
    // Do not include request bodies or parser diagnostics in a runner error.
    throw new Error('Unsupported explanation request for numeric evidence.');
  }
}
