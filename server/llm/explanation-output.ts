import { z } from 'zod';
import { explanationsSchema, explanationsMatch, requestIdSchema, type Candidate, type Explanation } from '../../shared/contracts.js';
import { ProviderError, type ExplanationValidationFailure } from './provider.js';

const surfaceKinds = ['spelling', 'spacing', 'usage', 'wording'] as const;
const meaningKinds = ['date', 'quantity', 'condition', 'negation', 'certainty', 'roles', 'action', 'request', 'other'] as const;
const kinds = [...surfaceKinds, ...meaningKinds] as const;
const fail = (stage: ExplanationValidationFailure): never => { throw new ProviderError('invalid', stage); };
const changeSchema = z.object({
  kind: z.enum(kinds), before: z.string().max(2000), after: z.string().max(2000), effect: z.string().max(400),
}).strict();
const noteSchema = z.object({ text: z.string().min(1).max(2000), reason: z.string().min(1).max(400) }).strict();
// Each change owns its evidence and effect. No separate reference table or summary template.
const draftSchema = z.object({
  candidateId: requestIdSchema, changes: z.array(changeSchema).max(12), notes: z.array(noteSchema).max(2),
}).strict();
const outputSchema = z.object({ explanations: z.array(draftSchema).min(1).max(3) }).strict();
export type ExplanationDraftObserver = (drafts: z.infer<typeof draftSchema>[]) => void;
const surfaceLabels: Record<typeof surfaceKinds[number], string> = {
  spelling: '맞춤법·오탈자 수정', spacing: '띄어쓰기 수정', usage: '문맥에 맞는 단어 수정', wording: '표현 다듬기',
};
const meaningLabels: Record<typeof meaningKinds[number], string> = {
  date: '날짜·시간', quantity: '수치·인원', condition: '조건', negation: '행동의 부정 여부',
  certainty: '확정·예정·가능성', roles: '누가 누구에게 하는지', action: '행동 내용', request: '요청 강도', other: '전달 내용',
};
const isSurface = (kind: typeof kinds[number]): kind is typeof surfaceKinds[number] => (surfaceKinds as readonly string[]).includes(kind);

export function explanationResponseSchema(candidates: Candidate[]) {
  // Keep nested array bounds local to avoid the previous Gemini schema complexity rejection.
  return { type: 'object', properties: { explanations: { type: 'array', minItems: 1, maxItems: 3,
    items: { type: 'object', properties: {
      candidateId: { type: 'string', enum: candidates.map(c => c.id) },
      changes: { type: 'array', items: { type: 'object', properties: {
        kind: { type: 'string', enum: [...kinds] }, before: { type: 'string' }, after: { type: 'string' }, effect: { type: 'string' },
      }, required: ['kind', 'before', 'after', 'effect'], additionalProperties: false } },
      notes: { type: 'array', items: { type: 'object', properties: {
        text: { type: 'string' }, reason: { type: 'string' },
      }, required: ['text', 'reason'], additionalProperties: false } },
    }, required: ['candidateId', 'changes', 'notes'], additionalProperties: false },
  } }, required: ['explanations'], additionalProperties: false };
}

// Only evidence fields can introduce quotes. Free prose is still a model claim, not verified meaning.
function prose(value: string): string {
  const text = value.trim().replace(/[.。]+$/u, '').trim();
  if (!text || /["'‘’“”「」『』`{}\r\n]/u.test(text)) return fail('change');
  return text;
}
function evidence(text: string, input: string) {
  if (text && (!text.trim() || !input.includes(text))) return fail('reference');
}

export function renderExplanations(source: string, candidates: Candidate[], decoded: unknown, observe?: ExplanationDraftObserver): Explanation[] {
  const parsed = outputSchema.safeParse(decoded);
  if (!parsed.success) return fail('schema');
  const drafts = parsed.data.explanations;
  if (drafts.length !== candidates.length || new Set(drafts.map(e => e.candidateId)).size !== candidates.length
    || drafts.some(e => !candidates.some(c => c.id === e.candidateId))) return fail('ids');
  observe?.(structuredClone(drafts));
  const rendered = drafts.map(draft => {
    const candidate = candidates.find(c => c.id === draft.candidateId)!;
    if (candidate.text === source) return { candidateId: draft.candidateId, explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' };
    if (!draft.changes.length) return fail('change');
    const originalKinds = new Set<typeof meaningKinds[number]>(), addedKinds = new Set<typeof meaningKinds[number]>();
    const seen = new Set<string>();
    const parts = draft.changes.map(change => {
      const { kind, before, after, effect } = change;
      evidence(before, source); evidence(after, candidate.text);
      if (before === after) return fail('change'); // Includes two empty fields and unchanged-word claims.
      const key = JSON.stringify([kind, before, after]);
      if (seen.has(key)) return fail('change');
      seen.add(key);
      let description: string;
      if (isSurface(kind)) {
        if (effect.trim()) return fail('change');
        if (kind === 'spacing' && before.replace(/\s/gu, '') !== after.replace(/\s/gu, '')) return fail('change');
        description = surfaceLabels[kind];
      } else {
        description = prose(effect);
        (before ? originalKinds : addedKinds).add(kind);
      }
      const transition = before && after ? `‘${before}’ → ‘${after}’` : before ? `‘${before}’ 삭제` : `‘${after}’ 추가`;
      return `${transition}: ${description}`;
    });
    for (const note of draft.notes) {
      // Notes describe remaining usage problems, not additional corrections or invented suggestions.
      evidence(note.text, source); evidence(note.text, candidate.text);
      parts.push(`남아 있는 ‘${note.text}’ 표현: ${prose(note.reason)}`);
    }
    const guidance = [];
    if (originalKinds.size) guidance.push(`원래 뜻을 전달하려면 ${[...originalKinds].map(kind => meaningLabels[kind]).join(', ')} 정보를 유지하면 됩니다`);
    if (addedKinds.size) guidance.push(`추가된 ${[...addedKinds].map(kind => meaningLabels[kind]).join(', ')} 정보가 의도한 내용인지 확인하면 선택에 도움이 됩니다`);
    return { candidateId: draft.candidateId, explanation: parts.join('; ') + '.' + (guidance.length ? ` ${guidance.join('; ')}.` : '') };
  });
  const result = explanationsSchema.safeParse(rendered);
  if (!result.success || !explanationsMatch(candidates, result.data)) return fail('length');
  return result.data;
}
