// Manual evaluation only. Never imported by the application.
export function withThinkingLevel(body, level) {
  if (!['LOW', 'HIGH'].includes(level)
    || body.generationConfig?.thinkingConfig?.thinkingLevel !== 'LOW') {
    throw new Error('Thinking experiment requires the current LOW baseline and LOW/HIGH target.');
  }
  const result = structuredClone(body);
  result.generationConfig.thinkingConfig.thinkingLevel = level;
  return result;
}

export function numericTokenUsage(envelope) {
  return Object.fromEntries(['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
    .filter(key => Number.isSafeInteger(envelope.usageMetadata?.[key]) && envelope.usageMetadata[key] >= 0)
    .map(key => [key, envelope.usageMetadata[key]]));
}
