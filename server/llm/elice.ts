import { z } from 'zod';
import { modelOutputSchema, explanationsSchema, explanationsMatch } from '../../shared/contracts.js';
import { ProviderError, type CorrectionProvider } from './provider.js';
import { correctionInstruction, explanationInstruction } from './prompt.js';

const envelopeSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional() }),
  })).length(1),
});

// Accept the model URL shown by Elice, with or without its /v1 suffix.
// Reject other hosts and redirects so a configuration typo cannot forward the key.
function completionUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ProviderError('configuration'); }
  if (url.protocol !== 'https:' || url.hostname !== 'mlapi.run' || url.port || url.username || url.password
    || url.search || url.hash || !/^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\/v1)?\/?$/i.test(url.pathname)) {
    throw new ProviderError('configuration');
  }
  const path = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '');
  return `${url.origin}${path}/v1/chat/completions`;
}

export function createEliceProvider(config: { apiKey: string; model: string; baseUrl: string }, fetcher: typeof fetch = fetch): CorrectionProvider {
  if (!config.apiKey.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(config.model)) throw new ProviderError('configuration');
  const url = completionUrl(config.baseUrl);
  async function generate(instruction: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(input) }],
          response_format: { type: 'json_object' },
          // Elice rejects non-streamed requests above its 2,000-token ceiling.
          n: 1, stream: false, max_tokens: 2000,
        }),
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new ProviderError('unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404, 422].includes(response.status)) throw new ProviderError('configuration');
      if ([402, 429].includes(response.status)) throw new ProviderError('quota');
      throw new ProviderError('unavailable');
    }
    let raw: unknown;
    try { raw = await response.json(); }
    catch { if (signal.aborted) throw signal.reason; throw new ProviderError('invalid'); }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('invalid');
    const choice = parsed.data.choices[0];
    if (choice.finish_reason === 'content_filter' || choice.message.refusal) throw new ProviderError('blocked');
    // Never display truncated JSON or tool calls as a complete correction.
    if (choice.finish_reason !== 'stop' || !choice.message.content) throw new ProviderError('invalid');
    try { return JSON.parse(choice.message.content); }
    catch { throw new ProviderError('invalid'); }
  }
  return {
    configured: true,
    async generateCandidates(sourceText, signal) {
      const decoded = await generate(correctionInstruction, { sourceText }, signal);
      const result = z.object({ candidates: modelOutputSchema }).strict().safeParse(decoded);
      if (!result.success) throw new ProviderError('invalid');
      return result.data.candidates;
    },
    async generateExplanations(sourceText, candidates, signal) {
      const decoded = await generate(explanationInstruction, { sourceText, candidates }, signal);
      const result = z.object({ explanations: explanationsSchema }).strict().safeParse(decoded);
      if (!result.success || !explanationsMatch(candidates, result.data.explanations)) throw new ProviderError('invalid');
      return result.data.explanations.map(e => candidates.find(c => c.id === e.candidateId)?.text === sourceText
        ? { ...e, explanation: '원문과 동일하여 변경된 표현이나 의미가 없습니다.' } : e);
    },
  };
}
