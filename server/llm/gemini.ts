import { z } from 'zod';
import { modelOutputSchema, explanationsSchema, explanationsMatch } from '../../shared/contracts.js';
import { ProviderError, type CorrectionProvider } from './provider.js';
import { correctionInstruction, explanationInstruction } from './prompt.js';

// One Gemini completion contains our 1–3 alternatives, not three API calls.
const envelopeSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z.array(z.object({
    finishReason: z.string().optional(),
    content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })) }).optional(),
  })).optional(),
});
const resultSchema = z.object({ candidates: modelOutputSchema }).strict();

export function createGeminiProvider(config: { apiKey: string; model: string }, fetcher: typeof fetch = fetch): CorrectionProvider {
  if (!config.apiKey.trim() || !/^gemini-[a-zA-Z0-9._-]+$/.test(config.model)) throw new ProviderError('configuration');
  async function generate(instruction: string, input: unknown, schema: unknown, signal: AbortSignal): Promise<unknown> {
      const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
          generationConfig: {
            candidateCount: 1, maxOutputTokens: 8192,
            // Short editing tasks do not need the model's default deeper reasoning.
            // Older Gemini models reject thinkingLevel; keep their defaults.
            ...(/^gemini-3[.-]/.test(config.model) ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
          },
        }),
      });
      // Never expose or log provider error bodies, which may contain request data.
      if (!response.ok) {
        await response.body?.cancel();
        if ([400, 401, 403, 404].includes(response.status)) throw new ProviderError('configuration');
        if (response.status === 429) throw new ProviderError('quota');
        throw new ProviderError('unavailable');
      }
      let raw: unknown;
      try { raw = await response.json(); }
      catch { if (signal.aborted) throw signal.reason; throw new ProviderError('invalid'); }
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError('invalid');
      if (parsed.data.promptFeedback?.blockReason) throw new ProviderError('blocked');
      const completions = parsed.data.candidates;
      if (!completions || completions.length !== 1) throw new ProviderError('invalid');
      const completion = completions[0];
      if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(completion.finishReason ?? '')) throw new ProviderError('blocked');
      if (completion.finishReason !== 'STOP') throw new ProviderError('invalid');
      const text = completion.content?.parts.filter(part => !part.thought).map(part => part.text ?? '').join('');
      if (!text) throw new ProviderError('invalid');
      let decoded: unknown;
      try { decoded = JSON.parse(text); } catch { throw new ProviderError('invalid'); }
      return decoded;
  }
  return {
    configured: true,
    async generateCandidates(sourceText, signal) {
      const decoded = await generate(correctionInstruction, { sourceText }, {
        type: 'object', properties: { candidates: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } },
        required: ['candidates'], additionalProperties: false,
      }, signal);
      const result = resultSchema.safeParse(decoded);
      if (!result.success) throw new ProviderError('invalid');
      return result.data.candidates;
    },
    async generateExplanations(sourceText, candidates, signal) {
      const decoded = await generate(explanationInstruction, { sourceText, candidates }, {
        type: 'object', properties: { explanations: { type: 'array', minItems: 1, maxItems: 3,
          items: { type: 'object', properties: { candidateId: { type: 'string', enum: candidates.map(c => c.id) }, explanation: { type: 'string' } },
            required: ['candidateId', 'explanation'], additionalProperties: false } } },
        required: ['explanations'], additionalProperties: false,
      }, signal);
      const result = z.object({ explanations: explanationsSchema }).strict().safeParse(decoded);
      if (!result.success || !explanationsMatch(candidates, result.data.explanations)) throw new ProviderError('invalid');
      // An identical candidate has no change to justify, regardless of model wording.
      return result.data.explanations.map(e => candidates.find(c => c.id === e.candidateId)?.text === sourceText
        ? { ...e, explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' } : e);
    },
  };
}
