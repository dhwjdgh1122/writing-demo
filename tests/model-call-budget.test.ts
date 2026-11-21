import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// The manual runner module is plain ESM and does not load provider settings.
// @ts-expect-error The JavaScript-only manual helper has no declaration file.
import { finishModelCall, MODEL_CALL_LIMITS, reserveModelCall } from '../scripts/lib/model-call-budget.mjs';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'writing-model-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.json');
  return { directory, path, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}
const metadata = (phase = 'development') => ({ phase, label: 'stage1-correction-01', provider: 'elice', model: 'gpt-4o-mini' });

test('reserves persistently before a response and never refunds interrupted or failed attempts', t => {
  const f = fixture(t);
  const unknown = reserveModelCall(f.path, metadata());
  assert.equal(f.read().calls[0].status, 'reserved');
  const failed = reserveModelCall(f.path, metadata());
  finishModelCall(f.path, failed, { status: 'failed' });
  const received = reserveModelCall(f.path, metadata('final'));
  finishModelCall(f.path, received, { status: 'received', httpStatus: 429 });
  assert.deepEqual(f.read().calls.map((call: { id: string; status: string }) => [call.id, call.status]), [
    [unknown, 'reserved'], [failed, 'failed'], [received, 'received'],
  ]);
  assert.deepEqual(f.read().limits, MODEL_CALL_LIMITS);
  assert.deepEqual(readdirSync(f.directory), ['ledger.json']);
});

test('enforces independent 24/84 phase caps and the 108-attempt total without changing rejected ledgers', t => {
  const f = fixture(t);
  for (let i = 0; i < 24; i++) reserveModelCall(f.path, metadata());
  const before = readFileSync(f.path, 'utf8');
  assert.throws(() => reserveModelCall(f.path, metadata()), /budget exhausted/);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  for (let i = 0; i < 84; i++) reserveModelCall(f.path, metadata('final'));
  assert.equal(f.read().calls.length, 108);
  for (const phase of ['development', 'final']) assert.throws(() => reserveModelCall(f.path, metadata(phase)), /budget exhausted/);
  assert.equal(f.read().calls.length, 108);
  assert.equal(existsSync(f.path + '.lock'), false);
});

test('rejects invalid phase, free text, URL, secret-shaped names and additional metadata before creating files', t => {
  const f = fixture(t);
  for (const input of [null, {}, metadata('other'), { ...metadata(), label: '사용자의 원문을 기록합니다.' },
    { ...metadata(), label: 'x'.repeat(81) }, { ...metadata(), model: 'x'.repeat(121) },
    { ...metadata(), model: 'https://provider.example/model' }, { ...metadata(), model: 'sk-secret' },
    { ...metadata(), provider: 'unapproved' }, { ...metadata(), sourceText: 'private-text' },
    { ...metadata(), apiKey: 'private-key' }]) {
    assert.throws(() => reserveModelCall(f.path, input), /Invalid model-call metadata/);
  }
  assert.deepEqual(readdirSync(f.directory), []);
});

test('malformed, altered, duplicated and over-budget ledgers are preserved instead of reset', t => {
  const f = fixture(t);
  reserveModelCall(f.path, metadata());
  const valid = f.read();
  const invalid = [
    '{broken', JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, limits: { ...valid.limits, development: 25 } }),
    JSON.stringify({ ...valid, apiKey: 'do-not-print' }),
    JSON.stringify({ ...valid, calls: [valid.calls[0], valid.calls[0]] }),
    JSON.stringify({ ...valid, calls: [{ ...valid.calls[0], status: 'reserved', httpStatus: 200 }] }),
    JSON.stringify({ ...valid, calls: [{ ...valid.calls[0], reservedAt: 'invalid' }] }),
    JSON.stringify({ ...valid, calls: [{ ...valid.calls[0], status: 'failed' }] }),
    JSON.stringify({ ...valid, calls: Array.from({ length: 25 }, () => ({ ...valid.calls[0], id: randomUUID() })) }),
    JSON.stringify({ ...valid, calls: Array.from({ length: 109 }, () => valid.calls[0]) }),
  ];
  for (const body of invalid) {
    writeFileSync(f.path, body);
    assert.throws(() => reserveModelCall(f.path, metadata()), /Invalid model-call ledger/);
    assert.equal(readFileSync(f.path, 'utf8'), body);
    assert.equal(existsSync(f.path + '.lock'), false);
  }
});

test('an existing lock prevents concurrent reserve/finish and is never removed automatically', t => {
  const f = fixture(t);
  const id = reserveModelCall(f.path, metadata());
  const before = readFileSync(f.path, 'utf8');
  const lock = openSync(f.path + '.lock', 'wx');
  closeSync(lock);
  for (const operation of [() => reserveModelCall(f.path, metadata()), () => finishModelCall(f.path, id, { status: 'failed' })]) {
    assert.throws(operation, /ledger is locked/);
    assert.equal(existsSync(f.path + '.lock'), true);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
});

test('finishing requires an existing reservation and cannot overwrite an outcome or attach raw errors', t => {
  const f = fixture(t);
  const missing = '00000000-0000-0000-0000-000000000000';
  assert.throws(() => finishModelCall(f.path, missing, { status: 'failed' }), /does not exist/);
  assert.equal(existsSync(f.path), false);
  const id = reserveModelCall(f.path, metadata());
  const before = readFileSync(f.path, 'utf8');
  for (const outcome of [{ status: 'reserved' }, { status: 'failed', error: 'private-error' },
    { status: 'received', httpStatus: 700 }, { status: 'received', httpStatus: '200' }]) {
    assert.throws(() => finishModelCall(f.path, id, outcome), /Invalid model-call outcome/);
  }
  assert.throws(() => finishModelCall(f.path, missing, { status: 'failed' }), /not found/);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  finishModelCall(f.path, id, { status: 'received', httpStatus: 200 });
  const finished = readFileSync(f.path, 'utf8');
  assert.throws(() => finishModelCall(f.path, id, { status: 'failed' }), /already recorded/);
  assert.equal(readFileSync(f.path, 'utf8'), finished);
});
