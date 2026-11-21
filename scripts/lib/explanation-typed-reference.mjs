// Offline parser proof only: hand-authored fixtures are not improved model outputs.
// Not imported by the product. Input quotes containing any quote mark are rejected
// as a conservative proof restriction, even when valid in the original sentence.
// General prose and dictionary application are not semantically verified.
import { z } from 'zod';
import { countCharacters, explanationInputSchema, explanationsMatch } from '../../shared/contracts.ts';
import { lexicalReferences } from './explanation-lexical-reference.mjs';

const knownEntries = [
  { id: 'krdict-32128', term: '결재하다', wordNumber: '32128' },
  { id: 'krdict-32140', term: '결제하다', wordNumber: '32140' },
];
export const typedReferenceCatalog = Object.freeze(knownEntries.map(({ id, term, wordNumber }) => {
  const entries = lexicalReferences.filter(entry => entry.term === term);
  const url = entries.length === 1 ? new URL(entries[0].sourceUrl) : undefined;
  if (!url || url.protocol !== 'https:' || url.hostname !== 'krdict.korean.go.kr'
    || url.searchParams.get('ParaWordNo') !== wordNumber || typeof entries[0].definition !== 'string' || !entries[0].definition.trim()) {
    throw new Error('Fixed dictionary provenance changed; review the proof catalog.');
  }
  const { definition, sourceUrl } = entries[0];
  return Object.freeze({ id, term, definition, sourceUrl });
}));
const quotationMark = /[\p{Quotation_Mark}`]/u;
const bounded = maximum => z.string().refine(text => text.length > 0 && countCharacters(text) <= maximum);
const segmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: bounded(400) }).strict(),
  z.object({ kind: z.literal('input_quote'), from: z.enum(['source', 'candidate']),
    quote: bounded(2000).refine(quote => quote.trim().length > 0) }).strict(),
  z.object({ kind: z.literal('lexical_reference'), id: z.string().min(1).max(100) }).strict(),
]);
const outputSchema = z.object({ explanations: z.array(z.object({
  candidateId: z.string().min(1).max(100), segments: z.array(segmentSchema).min(1).max(16),
}).strict()).min(1).max(3) }).strict();
const failure = error => ({ ok: false, error });

/** This proof checks origin and rendering only. A returned explanation may still
 * make a false claim, omit a change or misuse a dictionary term. It does not
 * enforce a 1–2 sentence instruction or score an explanation's usefulness.
 * Every input_quote has its own server-owned delimiters: text fragments never
 * combine into a newly accepted input quote. No normalization or quote repair.
 */
export function renderTypedReferenceProof(sourceText, candidates, decoded) {
  const input = explanationInputSchema.safeParse({ requestId: 'typed-reference-proof', sourceText, candidates });
  if (!input.success) return failure('invalid-input');
  const output = outputSchema.safeParse(decoded);
  if (!output.success) return failure('invalid-shape');
  if (!explanationsMatch(input.data.candidates, output.data.explanations)) return failure('candidate-ownership');
  const explanations = [];
  for (const draft of output.data.explanations) {
    const candidate = input.data.candidates.find(item => item.id === draft.candidateId);
    const parts = [], dictionaryEvidence = [], trustedMarkerRanges = [];
    let renderedOffset = 0;
    for (const segment of draft.segments) {
      if (segment.kind === 'text') {
        if (quotationMark.test(segment.text)) return failure('free-text-quote');
        parts.push(segment.text);
      } else if (segment.kind === 'input_quote') {
        // An experimental limitation, not a claim that real nested quotations
        // are incorrect. Reject rather than deleting or rewriting their marks.
        if (quotationMark.test(segment.quote)) return failure('nested-input-quote-unsupported');
        const owner = segment.from === 'source' ? input.data.sourceText : candidate.text;
        if (!owner.includes(segment.quote)) return failure('quote-not-in-declared-input');
        parts.push(`‘${segment.quote}’`);
        // A literal marker in a verified input quotation stays visibly quoted;
        // it is not promoted to dictionary evidence.
        trustedMarkerRanges.push({ start: renderedOffset + 1, end: renderedOffset + 1 + segment.quote.length, quoted: true });
      } else {
        const entry = typedReferenceCatalog.find(value => value.id === segment.id);
        if (!entry) return failure('unknown-lexical-reference');
        parts.push(`[사전 용어: ${entry.term}]`);
        trustedMarkerRanges.push({ start: renderedOffset, end: renderedOffset + parts.at(-1).length, quoted: false });
        if (!dictionaryEvidence.some(value => value.id === entry.id)) dictionaryEvidence.push({ ...entry });
      }
      renderedOffset += parts.at(-1).length;
    }
    const explanation = parts.join('');
    // Check after concatenation so split text segments cannot impersonate the
    // server-owned marker. Offsets use UTF-16 consistently with RegExp indices.
    for (const marker of explanation.matchAll(/\[사전\s*용어\s*:/gu)) {
      if (!trustedMarkerRanges.some(range => range.quoted
        ? marker.index >= range.start && marker.index + marker[0].length <= range.end
        : marker.index === range.start)) return failure('untrusted-reference-marker');
    }
    if (!explanation.trim() || countCharacters(explanation) > 400) return failure('rendered-length');
    explanations.push({ candidateId: draft.candidateId, explanation, dictionaryEvidence });
  }
  return { ok: true, explanations, semanticAssessment: 'not-performed' };
}
