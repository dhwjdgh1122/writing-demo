import { z } from 'zod';
import { explanationsSchema, explanationsMatch, requestIdSchema, type Candidate, type Explanation } from '../../shared/contracts.js';
import { ProviderError } from './provider.js';

// Provider-only format. The browser still receives { candidateId, explanation }.
const draftSchema = z.object({
  candidateId: requestIdSchema,
  references: z.array(z.object({
    side: z.enum(['source', 'candidate']),
    text: z.string().min(1).max(4000),
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
        changeSummary: { type: 'string' }, guidance: { type: 'string' },
      }, required: ['candidateId', 'references', 'changeSummary', 'guidance'], additionalProperties: false },
    } }, required: ['explanations'], additionalProperties: false,
  };
}

/** Verify literal references before inserting them; this does not verify meaning. */
export function renderExplanations(source: string, candidates: Candidate[], decoded: unknown): Explanation[] {
  const parsed = outputSchema.safeParse(decoded);
  if (!parsed.success) throw new ProviderError('invalid');
  const drafts = parsed.data.explanations;
  if (drafts.length !== candidates.length || new Set(drafts.map(e => e.candidateId)).size !== candidates.length
    || drafts.some(e => !candidates.some(c => c.id === e.candidateId))) throw new ProviderError('invalid');
  const rendered = drafts.map(draft => {
    const candidate = candidates.find(c => c.id === draft.candidateId)!;
    if (candidate.text === source) return { candidateId: draft.candidateId, explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' };
    if (!draft.references.length) throw new ProviderError('invalid');
    for (const ref of draft.references) {
      const input = ref.side === 'source' ? source : candidate.text;
      if (!ref.text.trim() || !input.includes(ref.text)) throw new ProviderError('invalid');
    }
    const used = new Set<number>();
    const render = (template: string) => {
      // Quotes must come from checked references, not another free-text copy.
      if (/["'‘’“”「」『』`]/u.test(template)) throw new ProviderError('invalid');
      const stripped = template.replace(/\{\{(0|[1-9]\d*)\}\}/gu, '');
      if (/[{}]/u.test(stripped)) throw new ProviderError('invalid');
      return template.replace(/\{\{(0|[1-9]\d*)\}\}/gu, (_match, raw: string) => {
        const index = Number(raw);
        const ref = draft.references[index];
        if (!ref) throw new ProviderError('invalid');
        used.add(index);
        return `‘${ref.text}’`;
      }).trim();
    };
    const summary = render(draft.changeSummary);
    if (!summary || used.size === 0) throw new ProviderError('invalid');
    const guidance = render(draft.guidance);
    if (used.size !== draft.references.length) throw new ProviderError('invalid');
    return { candidateId: draft.candidateId, explanation: [summary, guidance].filter(Boolean).join(' ') };
  });
  const result = explanationsSchema.safeParse(rendered);
  if (!result.success || !explanationsMatch(candidates, result.data)) throw new ProviderError('invalid');
  return result.data;
}
