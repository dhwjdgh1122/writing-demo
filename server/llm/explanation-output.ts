import { z } from 'zod';
import { explanationsSchema, explanationsMatch, requestIdSchema, type Candidate, type Explanation } from '../../shared/contracts.js';
import { ProviderError, type ExplanationValidationFailure } from './provider.js';

const meaningKinds = ['date', 'quantity', 'condition', 'negation', 'certainty', 'roles', 'action', 'request', 'other'] as const;
const fail = (stage: ExplanationValidationFailure): never => { throw new ProviderError('invalid', stage); };

// Provider-only format. The browser still receives { candidateId, explanation }.
const draftSchema = z.object({
  candidateId: requestIdSchema,
  references: z.array(z.object({
    side: z.enum(['source', 'candidate']),
    text: z.string().min(1).max(4000),
  }).strict()).max(12),
  meaningChanges: z.array(z.object({
    kind: z.enum(meaningKinds),
    sourceRefs: z.array(z.number().int().min(0).max(11)).max(12),
    candidateRefs: z.array(z.number().int().min(0).max(11)).max(12),
  }).strict()).max(12),
  changeSummary: z.string().min(1).max(2000),
  guidance: z.string().max(2000),
}).strict();
const outputSchema = z.object({ explanations: z.array(draftSchema).min(1).max(3) }).strict();

export function explanationResponseSchema(candidates: Candidate[]) {
  return {
    type: 'object', properties: { explanations: { type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'object', properties: {
        candidateId: { type: 'string', enum: candidates.map(c => c.id) },
        references: { type: 'array', maxItems: 12, items: { type: 'object', properties: {
          side: { type: 'string', enum: ['source', 'candidate'] }, text: { type: 'string' },
        }, required: ['side', 'text'], additionalProperties: false } },
        meaningChanges: { type: 'array', maxItems: 12, items: { type: 'object', properties: {
          kind: { type: 'string', enum: [...meaningKinds] },
          sourceRefs: { type: 'array', maxItems: 12, items: { type: 'integer', minimum: 0, maximum: 11 } },
          candidateRefs: { type: 'array', maxItems: 12, items: { type: 'integer', minimum: 0, maximum: 11 } },
        }, required: ['kind', 'sourceRefs', 'candidateRefs'], additionalProperties: false } },
        changeSummary: { type: 'string' }, guidance: { type: 'string' },
      }, required: ['candidateId', 'references', 'meaningChanges', 'changeSummary', 'guidance'], additionalProperties: false },
    } }, required: ['explanations'], additionalProperties: false,
  };
}

/** Verify literal references before inserting them; this does not verify meaning. */
export function renderExplanations(source: string, candidates: Candidate[], decoded: unknown): Explanation[] {
  const parsed = outputSchema.safeParse(decoded);
  if (!parsed.success) return fail('schema');
  const drafts = parsed.data.explanations;
  if (drafts.length !== candidates.length || new Set(drafts.map(e => e.candidateId)).size !== candidates.length
    || drafts.some(e => !candidates.some(c => c.id === e.candidateId))) return fail('ids');
  const rendered = drafts.map(draft => {
    const candidate = candidates.find(c => c.id === draft.candidateId)!;
    if (candidate.text === source) return { candidateId: draft.candidateId, explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' };
    if (!draft.references.length) return fail('reference');
    for (const ref of draft.references) {
      const input = ref.side === 'source' ? source : candidate.text;
      if (!ref.text.trim() || !input.includes(ref.text)) return fail('reference');
    }
    const used = new Set<number>();
    const render = (template: string) => {
      // Quotes must come from checked references, not another free-text copy.
      if (/["'‘’“”「」『』`]/u.test(template)) return fail('template');
      const stripped = template.replace(/\{\{(0|[1-9]\d*)\}\}/gu, '');
      if (/[{}]/u.test(stripped)) return fail('template');
      return template.replace(/\{\{(0|[1-9]\d*)\}\}/gu, (_match, raw: string) => {
        const index = Number(raw);
        const ref = draft.references[index];
        if (!ref) return fail('template');
        used.add(index);
        return `‘${ref.text}’`;
      }).trim();
    };
    const summary = render(draft.changeSummary);
    if (!summary || used.size === 0) return fail('template');
    // Only declared changes are linked here; this is not a semantic detector.
    const original = new Set<string>();
    const additions = new Set<string>();
    for (const change of draft.meaningChanges) {
      if (!change.sourceRefs.length && !change.candidateRefs.length) return fail('meaning-link');
      for (const [side, indices] of [['source', change.sourceRefs], ['candidate', change.candidateRefs]] as const) {
        if (new Set(indices).size !== indices.length) return fail('meaning-link');
        for (const index of indices) {
          const ref = draft.references[index];
          if (!ref || ref.side !== side || !used.has(index)) return fail('meaning-link');
        }
      }
      for (const index of change.sourceRefs) original.add(draft.references[index].text);
      if (!change.sourceRefs.length) for (const index of change.candidateRefs) {
        const text = draft.references[index].text;
        if (source.includes(text)) return fail('meaning-link');
        additions.add(text);
      }
    }
    let guidance: string;
    if (draft.meaningChanges.length) {
      if (draft.guidance.trim()) return fail('meaning-link');
      const quoted = (values: Set<string>) => [...values].map(text => `‘${text}’`).join(', ');
      const parts = [];
      if (original.size) parts.push(`원래 뜻을 전달하려면 ${quoted(original)} 내용을 유지하는 편이 좋습니다`);
      if (additions.size) parts.push(`추가된 ${quoted(additions)} 내용은 원문에 없어 의도한 정보인지 확인하면 선택에 도움이 됩니다`);
      guidance = parts.join('; ') + '.';
    } else guidance = render(draft.guidance);
    if (used.size !== draft.references.length) return fail('template');
    return { candidateId: draft.candidateId, explanation: [summary, guidance].filter(Boolean).join(' ') };
  });
  const result = explanationsSchema.safeParse(rendered);
  if (!result.success || !explanationsMatch(candidates, result.data)) return fail('length');
  return result.data;
}
