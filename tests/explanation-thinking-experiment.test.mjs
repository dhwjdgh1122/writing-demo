import test from 'node:test';
import assert from 'node:assert/strict';
import { withThinkingLevel, numericTokenUsage } from '../scripts/lib/explanation-thinking-experiment.mjs';

test('thinking comparison changes only reasoning level and refuses incompatible baseline', () => {
  const body = { systemInstruction: { parts: [{ text: 'same prompt' }] }, contents: [{ text: 'same input' }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'LOW' }, responseJsonSchema: { type: 'object' } } };
  const changed = withThinkingLevel(body, 'HIGH');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(changed.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  changed.generationConfig.thinkingConfig.thinkingLevel = 'LOW';
  assert.deepEqual(changed, body);
  assert.deepEqual(withThinkingLevel(body, 'LOW'), body);
  assert.throws(() => withThinkingLevel({}, 'HIGH'));
  assert.throws(() => withThinkingLevel(body, 'MEDIUM'));
});

test('manual usage capture keeps only valid token counters, not thought content or metadata', () => {
  assert.deepEqual(numericTokenUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2,
    thoughtsTokenCount: -1, totalTokenCount: '12', secret: 'not stored' }, thoughts: 'not stored' }),
  { promptTokenCount: 10, candidatesTokenCount: 2 });
  assert.deepEqual(numericTokenUsage({}), {});
});
