import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
// @ts-expect-error Manual JavaScript helper intentionally has no declaration file.
import { finishContinuationCall, inspectContinuationLedger, reserveContinuationCall } from '../scripts/lib/model-call-continuation.mjs';
// @ts-expect-error Importing the runner exposes only pure helpers; main is guarded.
import { buildContinuationPlan, continuationInput } from '../scripts/evaluate-explanation-continuation.mjs';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'writing-continuation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.json'), previousPath = join(directory, 'previous.json');
  const previous = JSON.stringify({ version: 1, limits: { development: 24, final: 84, total: 108 },
    calls: Array.from({ length: 19 }, (_, i) => ({ id: randomUUID(), phase: 'development', label: `old-${i}`,
      provider: 'elice', model: 'gpt-4o-mini', reservedAt: '2026-11-21T00:00:00.000Z', status: 'reserved' })) });
  writeFileSync(previousPath, previous);
  const value = { version: 2, previousLedger: { path: previousPath,
    sha256: createHash('sha256').update(previous).digest('hex'), calls: 19 },
    authorization: { mode: 'until-user-stop', numericCallLimit: null }, calls: [] };
  writeFileSync(path, JSON.stringify(value));
  return { directory, path, previousPath, previous, value, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}
const metadata = (label = 'E01-baseline', provider = 'elice', experimentId = 'pilot-01') => ({
  experimentId, label, provider, model: provider === 'elice' ? 'gpt-4o-mini' : 'gemini-3.5-flash-lite',
});

test('continuation reservations persist before request dispatch and preserve the original 19-call ledger', t => {
  const f = fixture(t);
  const dispatch = (label: string, outcome?: { status: string; httpStatus?: number }) => {
    const id = reserveContinuationCall(f.path, metadata(label), 3);
    // This assertion models the exact boundary before a runner can dispatch fetch.
    assert.equal(f.read().calls.find((call: { id: string }) => call.id === id).status, 'reserved');
    if (outcome) finishContinuationCall(f.path, id, outcome);
    return id;
  };
  dispatch('interrupted'); dispatch('failed', { status: 'failed' }); dispatch('received', { status: 'received', httpStatus: 429 });
  assert.deepEqual(f.read().calls.map((call: { status: string }) => call.status), ['reserved', 'failed', 'received']);
  assert.equal(readFileSync(f.previousPath, 'utf8'), f.previous);
  assert.deepEqual(f.read().authorization, f.value.authorization);
  assert.deepEqual(readdirSync(f.directory).sort(), ['ledger.json', 'previous.json']);
});

test('continuation caps include interrupted attempts and cannot be raised or replayed under one experiment', t => {
  const f = fixture(t);
  reserveContinuationCall(f.path, metadata('one'), 2);
  assert.throws(() => reserveContinuationCall(f.path, metadata('one'), 2), /already reserved/);
  assert.throws(() => reserveContinuationCall(f.path, metadata('two'), 3), /cap\/model changed/);
  reserveContinuationCall(f.path, metadata('two'), 2);
  const before = readFileSync(f.path, 'utf8');
  assert.throws(() => reserveContinuationCall(f.path, metadata('three'), 2), /budget exhausted/);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  reserveContinuationCall(f.path, metadata('one', 'gemini'), 2);
  reserveContinuationCall(f.path, metadata('one', 'elice', 'pilot-02'), 1);
  assert.equal(f.read().calls.length, 4);
  assert.equal(existsSync(f.path + '.lock'), false);
});

test('continuation finish cannot invent, replace, or leak details into an outcome', t => {
  const f = fixture(t);
  const id = reserveContinuationCall(f.path, metadata(), 2);
  const before = readFileSync(f.path, 'utf8');
  for (const outcome of [{ status: 'reserved' }, { status: 'received', httpStatus: 600 },
    { status: 'received', httpStatus: '200' }, { status: 'failed', httpStatus: 200 }, { status: 'failed', error: 'private-error' }]) {
    assert.throws(() => finishContinuationCall(f.path, id, outcome), /Invalid continuation outcome/);
  }
  assert.throws(() => finishContinuationCall(f.path, randomUUID(), { status: 'failed' }), /not found/);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  finishContinuationCall(f.path, id, { status: 'received', httpStatus: 200 });
  const finished = readFileSync(f.path, 'utf8');
  assert.throws(() => finishContinuationCall(f.path, id, { status: 'failed' }), /already recorded/);
  assert.equal(readFileSync(f.path, 'utf8'), finished);
});

test('malformed, revoked, unlinked or altered continuation ledgers are preserved and locks are cleaned', t => {
  const f = fixture(t);
  const invalid = ['{broken', JSON.stringify({ ...f.value, version: 1 }),
    JSON.stringify({ ...f.value, authorization: { mode: 'stopped', numericCallLimit: null } }),
    JSON.stringify({ ...f.value, authorization: { mode: 'until-user-stop', numericCallLimit: 108 } }),
    JSON.stringify({ ...f.value, previousLedger: { ...f.value.previousLedger, calls: 18 } }),
    JSON.stringify({ ...f.value, previousLedger: { ...f.value.previousLedger, sha256: '0'.repeat(64) } }),
    JSON.stringify({ ...f.value, apiKey: 'do-not-print' })];
  for (const text of invalid) {
    writeFileSync(f.path, text);
    assert.throws(() => reserveContinuationCall(f.path, metadata(), 2), /Invalid continuation ledger/);
    assert.equal(readFileSync(f.path, 'utf8'), text);
    assert.equal(existsSync(f.path + '.lock'), false);
  }
  writeFileSync(f.path, JSON.stringify(f.value));
  writeFileSync(f.previousPath, f.previous + '\n');
  assert.throws(() => inspectContinuationLedger(f.path), /Invalid continuation ledger/);
  assert.equal(readFileSync(f.previousPath, 'utf8'), f.previous + '\n');
  const missing = join(f.directory, 'missing.json');
  assert.throws(() => reserveContinuationCall(missing, metadata(), 2), /does not exist/);
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(missing + '.lock'), false);
});

test('existing continuation lock blocks reserve and finish without removing another process lock', t => {
  const f = fixture(t);
  const id = reserveContinuationCall(f.path, metadata(), 2);
  const before = readFileSync(f.path, 'utf8');
  closeSync(openSync(f.path + '.lock', 'wx'));
  for (const operation of [() => reserveContinuationCall(f.path, metadata('other'), 2),
    () => finishContinuationCall(f.path, id, { status: 'failed' })]) {
    assert.throws(operation, /ledger is locked/);
    assert.equal(existsSync(f.path + '.lock'), true);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
});

test('invalid continuation metadata is rejected without touching either ledger', t => {
  const f = fixture(t), before = readFileSync(f.path, 'utf8');
  for (const value of [null, {}, { ...metadata(), apiKey: 'private' }, { ...metadata(), label: '원문 내용' },
    { ...metadata(), model: 'sk-secret' }, { ...metadata(), provider: 'other' }, { ...metadata(), experimentId: '' }]) {
    assert.throws(() => reserveContinuationCall(f.path, value, 2), /Invalid continuation metadata/);
  }
  for (const cap of [0, -1, 1.2, Infinity, '2']) assert.throws(() => reserveContinuationCall(f.path, metadata(), cap), /Invalid continuation metadata/);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.equal(readFileSync(f.previousPath, 'utf8'), f.previous);
});

const experimentConfig = { experimentId: 'pilot-01', fixturePath: 'tests/fixtures/pilot.json', caseIds: ['E01', 'E02'],
  arms: [{ id: 'baseline', instructionExport: 'baselineInstruction' }, { id: 'contrast', instructionExport: 'contrastInstruction' }],
  promptModule: 'scripts/lib/prompt.mjs', reportPrefix: 'docs/evaluations/pilot', perProviderMaxCalls: 4,
  ledgerPath: 'docs/evaluations/continuation-ledger.json' };
const experimentCases = ['E01', 'E02'].map(id => ({ id, sourceText: '원문입니다.', candidates: [{ id: `${id}-c1`, text: '후보입니다.' }],
  required: ['THIS-IS-AN-ANSWER'], forbidden: ['NEVER-SEND-THIS'], origin: 'report-only' }));

test('continuation plan alternates paired arm order and rejects over-budget or incomplete plans', () => {
  const { plan } = buildContinuationPlan(experimentConfig, experimentCases);
  assert.deepEqual(plan, [{ caseId: 'E01', arm: 'baseline' }, { caseId: 'E01', arm: 'contrast' },
    { caseId: 'E02', arm: 'contrast' }, { caseId: 'E02', arm: 'baseline' }]);
  assert.throws(() => buildContinuationPlan({ ...experimentConfig, perProviderMaxCalls: 3 }, experimentCases), /exceed/);
  assert.throws(() => buildContinuationPlan({ ...experimentConfig, caseIds: ['missing'] }, experimentCases), /missing/);
  assert.throws(() => buildContinuationPlan({ ...experimentConfig, caseIds: ['E01', 'E01'] }, experimentCases), /Invalid/);
  assert.throws(() => buildContinuationPlan({ ...experimentConfig, arms: [experimentConfig.arms[0], experimentConfig.arms[0]] }, experimentCases), /Invalid/);
});

test('continuation submitted input whitelists source and candidates, never fixture answers or metadata', () => {
  const input = continuationInput(experimentCases[0], 'run-1');
  assert.deepEqual(input, { requestId: 'run-1', sourceText: '원문입니다.', candidates: [{ id: 'E01-c1', text: '후보입니다.' }] });
  assert.ok(!JSON.stringify(input).includes('THIS-IS-AN-ANSWER'));
  assert.ok(!JSON.stringify(input).includes('NEVER-SEND-THIS'));
  assert.ok(!JSON.stringify(input).includes('report-only'));
});
