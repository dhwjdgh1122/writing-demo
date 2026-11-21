import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
// @ts-expect-error Manual JavaScript runner has a guarded entry point and no declaration file.
import { buildContinuationPlan, continuationCallLabel, continuationInput, continuationModelInput, continuationSamplingBody, continuationRequestSettings, runContinuation } from '../scripts/evaluate-explanation-continuation.mjs';

const cases = ['A', 'B'].map(id => ({ id, sourceText: '자료를 보내 주세여.', candidates: [{ id: `${id}-c`, text: '자료를 보내 주세요.' }],
  required: ['PRIVATE-ANSWER'], repetition: 99, verdict: 'PRIVATE-VERDICT' }));
const config = { experimentId: 'sampling-test', fixturePath: 'tests/fixtures/test.json', caseIds: ['A', 'B'],
  arms: [{ id: 'default', instructionExport: 'baselineInstruction' }, { id: 'zero', instructionExport: 'baselineInstruction', temperature: 0 }],
  promptModule: 'scripts/lib/explanation-freeform-contrast.mjs', reportPrefix: 'test-results/sampling', perProviderMaxCalls: 8,
  ledgerPath: 'test-results/ledger.json' };
const providerBody = { model: 'gpt-4o-mini', response_format: { type: 'json_object' }, n: 1, stream: false, max_tokens: 2000,
  messages: [{ role: 'system', content: 'Same instruction.' }, { role: 'user', content: 'Same input.' }] };

test('two repetitions invert paired order by case and repeat, with unique ledger labels and no input leakage', () => {
  const before = structuredClone({ config, cases });
  const repeated = buildContinuationPlan({ ...config, repetitions: 2 }, cases).plan;
  assert.deepEqual(repeated.map(continuationCallLabel), ['A-default-r1', 'A-zero-r1', 'A-zero-r2', 'A-default-r2',
    'B-zero-r1', 'B-default-r1', 'B-default-r2', 'B-zero-r2']);
  assert.equal(new Set(repeated.map(continuationCallLabel)).size, 8);
  for (const entry of repeated) {
    const submitted = continuationInput(cases.find(c => c.id === entry.caseId), 'run');
    const sent = continuationModelInput({ sourceText: submitted.sourceText, candidates: submitted.candidates }, submitted);
    assert.deepEqual(Object.keys(sent), ['sourceText', 'candidates']);
    assert.equal(JSON.stringify(sent).includes('PRIVATE-'), false);
    assert.equal(Object.hasOwn(sent, 'repetition'), false);
  }
  assert.deepEqual({ config, cases }, before);
  const legacy = buildContinuationPlan(config, cases).plan;
  assert.deepEqual(legacy, [{ caseId: 'A', arm: 'default' }, { caseId: 'A', arm: 'zero' },
    { caseId: 'B', arm: 'zero' }, { caseId: 'B', arm: 'default' }]);
  assert.deepEqual(buildContinuationPlan({ ...config, repetitions: 1 }, cases).plan, legacy);
  assert.deepEqual(legacy.map(continuationCallLabel), ['A-default', 'A-zero', 'B-zero', 'B-default']);
  assert.throws(() => buildContinuationPlan({ ...config, repetitions: 2, perProviderMaxCalls: 7 }, cases), /exceed/);
});

test('sampling plan accepts only optional temperature zero and one or two repetitions', () => {
  for (const repetitions of [0, 3, -1, 1.5, '2', null, undefined]) {
    assert.throws(() => buildContinuationPlan({ ...config, repetitions }, cases), /Invalid/);
  }
  for (const temperature of [1, 0.1, '0', null, undefined, NaN]) {
    assert.throws(() => buildContinuationPlan({ ...config, arms: [config.arms[0], { ...config.arms[1], temperature }] }, cases), /Invalid/);
  }
  for (const extra of [{ top_p: 0.5 }, { seed: 1 }, { correctLabel: 'expected' }]) {
    assert.throws(() => buildContinuationPlan({ ...config, arms: [config.arms[0], { ...config.arms[1], ...extra }] }, cases), /Invalid/);
  }
});

test('temperature zero changes only the Elice request sampling field and actual settings preserve absence versus zero', () => {
  const before = structuredClone(providerBody);
  const baseline = continuationSamplingBody('elice', providerBody, config.arms[0]);
  const zero = continuationSamplingBody('elice', providerBody, config.arms[1]);
  assert.deepEqual(baseline, providerBody);
  assert.deepEqual(zero, { ...providerBody, temperature: 0 });
  assert.equal(Object.hasOwn(continuationRequestSettings('elice', baseline), 'temperature'), false);
  assert.equal(continuationRequestSettings('elice', zero).temperature, 0);
  baseline.messages[0].content = 'changed'; zero.messages[1].content = 'changed';
  assert.deepEqual(providerBody, before);
  for (const key of ['temperature', 'top_p', 'topP', 'seed', 'top_k', 'topK']) {
    assert.throws(() => continuationSamplingBody('elice', { ...providerBody, [key]: 0 }, config.arms[1]), /cannot overwrite/);
  }
  assert.throws(() => continuationSamplingBody('gemini', { generationConfig: {} }, config.arms[1]), /only for elice/);
  assert.deepEqual(continuationSamplingBody('gemini', { generationConfig: { maxOutputTokens: 8192 } }, config.arms[0]),
    { generationConfig: { maxOutputTokens: 8192 } });
});

test('Gemini sampling plans are rejected before prompt loading, report writes, ledger access or live calls', async t => {
  const root = resolve('.'), directory = mkdtempSync(join(root, '.sampling-preflight-'));
  t.after(() => {
    assert.equal(resolve(directory).startsWith(root + '\\') || resolve(directory).startsWith(root + '/'), true);
    rmSync(directory, { recursive: true, force: true });
  });
  const fixturePath = join(directory, 'fixture.json'), planPath = join(directory, 'plan.json');
  const reportPrefix = join(directory, 'report');
  writeFileSync(fixturePath, JSON.stringify(cases));
  writeFileSync(planPath, JSON.stringify({ ...config, fixturePath, reportPrefix,
    // A missing prompt module and ledger prove the provider guard runs first.
    promptModule: join(directory, 'missing-prompt.mjs'), ledgerPath: join(directory, 'missing-ledger.json') }));
  const before = readdirSync(directory).sort();
  await assert.rejects(runContinuation([`--plan=${relative(process.cwd(), planPath)}`, '--provider=gemini', '--live']), /only for elice/);
  assert.deepEqual(readdirSync(directory).sort(), before);
  assert.equal(existsSync(reportPrefix + '-gemini.json'), false);
});
