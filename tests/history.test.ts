import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHistoryOperation, createHistoryController, HISTORY_KEY, HISTORY_MAX_BYTES,
  HISTORY_MAX_RECORDS, parseHistory, serializeHistory,
  type HistoryLock, type HistoryRecord, type HistoryStorage,
} from '../client/src/lib/history.js';

const at = '2026-11-21T03:00:00.000Z';
const record = (id = 'r1'): HistoryRecord => ({
  id, createdAt: at, sourceText: '앞 문장\n\n뒤 문장 😀',
  candidates: [{ id: `${id}-c1`, text: '앞 문장입니다.\n\n뒤 문장입니다. 😀' }],
  explanations: [], appliedCandidateId: null, appliedAt: null,
});
class MemoryStorage implements HistoryStorage {
  value: string | null = null;
  quota = false;
  unavailable = false;
  writes = 0;
  removals = 0;
  getItem(key: string) {
    assert.equal(key, HISTORY_KEY);
    if (this.unavailable) throw new Error('unavailable');
    return this.value;
  }
  setItem(key: string, value: string) {
    assert.equal(key, HISTORY_KEY);
    if (this.quota || this.unavailable) throw new Error('storage cannot write');
    this.value = value; this.writes += 1;
  }
  removeItem(key: string) {
    assert.equal(key, HISTORY_KEY);
    if (this.unavailable) throw new Error('unavailable');
    this.value = null; this.removals += 1;
  }
}
function serializedLock(): HistoryLock {
  let tail: Promise<unknown> = Promise.resolve();
  return action => {
    const result = tail.then(action);
    tail = result.catch(() => undefined);
    return result;
  };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function settled() {
  // Drain both controller microtasks and chained lock promises without wall-clock sleeps.
  await new Promise<void>(resolve => setImmediate(resolve));
}
function controller(storage = new MemoryStorage(), lock: HistoryLock | undefined = serializedLock()) {
  return createHistoryController({ getStorage: () => storage, lock });
}

test('round trip preserves selected text, line breaks, explanations, application and parent linkage', () => {
  const entry: HistoryRecord = { ...record(), parentRecordId: 'previous',
    explanations: [{ candidateId: 'r1-c1', explanation: '문장 종결 표현을 바꿨습니다.' }],
    appliedCandidateId: 'r1-c1', appliedAt: at };
  assert.deepEqual(parseHistory(serializeHistory([entry])), [entry]);
  assert.deepEqual(parseHistory(null), []);
});

test('invalid versions, duplicate IDs and mismatched explanation/application links are rejected', () => {
  const invalid = [
    { version: 2, records: [] }, { version: 1, records: [record(), record()] },
    { version: 1, records: [{ ...record(), explanations: [{ candidateId: 'other', explanation: '이유' }] }] },
    { version: 1, records: [{ ...record(), appliedCandidateId: 'other', appliedAt: at }] },
    { version: 1, records: [{ ...record(), appliedAt: at }] },
    { version: 1, records: [{ ...record(), parentRecordId: 'r1' }] },
  ];
  for (const value of invalid) assert.throws(() => parseHistory(JSON.stringify(value)));
  assert.throws(() => parseHistory('{broken'));
});

test('candidate revision history preserves its target and old records remain readable without target metadata', () => {
  const previous = record('previous');
  const revision: HistoryRecord = { ...record('revision'), parentRecordId: previous.id, phase: 'before_apply',
    targetCandidate: previous.candidates[0], requirement: 'plain' };
  const loaded = parseHistory(serializeHistory([revision, previous]));
  assert.deepEqual(loaded, [revision, previous]);
  assert.equal(Object.hasOwn(loaded[1], 'targetCandidate'), false);
  const changed = applyHistoryOperation(loaded, { type: 'apply', id: previous.id, candidateId: previous.candidates[0].id, at });
  assert.equal(changed[0].appliedCandidateId, null);
  assert.equal(changed[1].appliedCandidateId, previous.candidates[0].id);
  assert.throws(() => serializeHistory([{ ...revision, targetCandidate: { id: 'bad', text: '가'.repeat(2001) } }]));
});

test('safety limits reject whole documents without silently dropping old records', () => {
  assert.throws(() => parseHistory(' '.repeat(HISTORY_MAX_BYTES / 2 + 1)));
  const entries = Array.from({ length: HISTORY_MAX_RECORDS + 1 }, (_, index) => record(`r${index}`));
  assert.throws(() => serializeHistory(entries));
  assert.equal(entries.length, HISTORY_MAX_RECORDS + 1);
});

test('repeated explanation callbacks are idempotent and failed retry preserves successful explanation', () => {
  const entries = applyHistoryOperation([record()], { type: 'explanations', id: 'r1',
    values: [{ candidateId: 'r1-c1', explanation: '실제로 받은 설명입니다.' }] });
  assert.equal(applyHistoryOperation(entries, { type: 'explanations', id: 'r1', values: entries[0].explanations }), entries);
  assert.equal(applyHistoryOperation(entries, { type: 'explanations', id: 'r1',
    values: [{ candidateId: 'r1-c1', error: 'EXPLANATION_QUOTE_MISMATCH' }] }), entries);
  assert.equal(applyHistoryOperation(entries, { type: 'add', record: record() }), entries);
});

test('only valid accepted application is recorded and late patches cannot recreate deleted history', () => {
  const entries = [record()];
  assert.equal(applyHistoryOperation(entries, { type: 'apply', id: 'r1', candidateId: 'unknown', at }), entries);
  const applied = applyHistoryOperation(entries, { type: 'apply', id: 'r1', candidateId: 'r1-c1', at });
  assert.equal(applied[0].appliedAt, at);
  assert.equal(entries[0].appliedAt, null);
  assert.equal(applyHistoryOperation(applied, { type: 'apply', id: 'r1', candidateId: 'r1-c1', at }), applied);
  const removed = applyHistoryOperation(applied, { type: 'remove', id: 'r1' });
  assert.equal(applyHistoryOperation(removed, { type: 'explanations', id: 'r1', values: [{ candidateId: 'r1-c1', explanation: '늦은 응답' }] }), removed);
  assert.equal(applyHistoryOperation(removed, { type: 'apply', id: 'r1', candidateId: 'r1-c1', at }), removed);
});

test('candidate switches retain the latest accepted application without replaying stale patches', () => {
  const original = record();
  original.candidates.push({ id: 'r1-c2', text: '다른 후보입니다.' });
  const first = applyHistoryOperation([original], { type: 'apply', id: 'r1', candidateId: 'r1-c1', at });
  const later = '2026-11-21T03:01:00.000Z';
  const switched = applyHistoryOperation(first, { type: 'apply', id: 'r1', candidateId: 'r1-c2', at: later });
  assert.equal(switched[0].appliedCandidateId, 'r1-c2');
  assert.equal(switched[0].appliedAt, later);
  assert.equal(applyHistoryOperation(switched, { type: 'apply', id: 'r1', candidateId: 'r1-c1', at }), switched);
  assert.equal(applyHistoryOperation(switched, { type: 'apply', id: 'r1', candidateId: 'r1-c2', at: later }), switched);
  const returned = applyHistoryOperation(switched, { type: 'apply', id: 'r1', candidateId: 'r1-c1', at: '2026-11-21T03:02:00.000Z' });
  assert.equal(returned[0].appliedCandidateId, 'r1-c1');
  assert.equal(returned[0].sourceText, original.sourceText);
  assert.deepEqual(parseHistory(serializeHistory(returned)), returned);
});

test('accepted record and later metadata persist and load after a new controller starts', async () => {
  const storage = new MemoryStorage();
  const first = controller(storage);
  first.enqueue({ type: 'add', record: record() });
  first.enqueue({ type: 'explanations', id: 'r1', values: [{ candidateId: 'r1-c1', explanation: '받은 설명' }] });
  first.enqueue({ type: 'apply', id: 'r1', candidateId: 'r1-c1', at });
  await settled();
  assert.equal(first.getSnapshot().status, 'saved');
  const second = controller(storage); second.start();
  assert.deepEqual(second.getSnapshot().records, first.getSnapshot().records);
  assert.equal(second.getSnapshot().records[0].appliedAt, at);
  assert.deepEqual(JSON.parse(first.exportJson()).records, second.getSnapshot().records);
  const writes = storage.writes;
  first.enqueue({ type: 'explanations', id: 'r1', values: [{ candidateId: 'r1-c1', explanation: '받은 설명' }] });
  await settled();
  assert.equal(storage.writes, writes);
});

test('concurrent tabs read the latest data inside the same lock and retain both accepted records', async () => {
  const storage = new MemoryStorage(); const lock = serializedLock();
  const first = controller(storage, lock); const second = controller(storage, lock);
  first.start(); second.start();
  first.enqueue({ type: 'add', record: record('first') });
  second.enqueue({ type: 'add', record: record('second') });
  await settled();
  assert.deepEqual(parseHistory(storage.value).map(item => item.id).sort(), ['first', 'second']);
  first.refresh(); second.refresh();
  assert.deepEqual(first.getSnapshot().records, second.getSnapshot().records);
});

test('a tab deleting a record is respected by a stale tab receiving a late explanation', async () => {
  const storage = new MemoryStorage(); storage.value = serializeHistory([record()]);
  const lock = serializedLock(); const first = controller(storage, lock); const second = controller(storage, lock);
  first.start(); second.start();
  first.remove('r1'); await settled();
  second.enqueue({ type: 'explanations', id: 'r1', values: [{ candidateId: 'r1-c1', explanation: '삭제 후 도착' }] });
  await settled();
  assert.deepEqual(parseHistory(storage.value), []);
  assert.deepEqual(second.getSnapshot().records, []);
  first.refresh();
  assert.deepEqual(first.getSnapshot().records, []);
});

test('quota failures keep pending additions and metadata exportable, retry persists them without duplication', async () => {
  const storage = new MemoryStorage(); storage.value = serializeHistory([record('old')]); storage.quota = true;
  const history = controller(storage);
  history.enqueue({ type: 'add', record: record('new') });
  await settled();
  history.enqueue({ type: 'apply', id: 'new', candidateId: 'new-c1', at });
  assert.equal(history.getSnapshot().status, 'error');
  assert.deepEqual(parseHistory(storage.value).map(item => item.id), ['old']);
  assert.equal(JSON.parse(history.exportJson()).records[0].appliedAt, at);
  history.remove('old'); storage.quota = false; history.retry();
  await settled();
  assert.equal(history.getSnapshot().status, 'saved');
  assert.deepEqual(parseHistory(storage.value).map(item => item.id), ['new']);
  assert.equal(parseHistory(storage.value)[0].appliedAt, at);
});

test('corrupt saved bytes survive refresh, new work, delete and retry until explicit reset', async () => {
  const storage = new MemoryStorage(); storage.value = '{broken';
  const history = controller(storage); history.start();
  assert.equal(history.getSnapshot().status, 'corrupt');
  history.enqueue({ type: 'add', record: record() });
  assert.equal(JSON.parse(history.exportJson()).records.length, 1);
  history.clear(); history.retry(); history.refresh(); await settled();
  assert.equal(storage.value, '{broken');
  assert.equal(storage.writes, 0);
  history.reset(); await settled();
  assert.equal(storage.value, null);
  assert.equal(history.getSnapshot().status, 'saved');
  history.enqueue({ type: 'add', record: record('after') }); await settled();
  assert.equal(parseHistory(storage.value)[0].id, 'after');
});

test('corruption introduced by another tab before write blocks replacement and keeps current work', async () => {
  const storage = new MemoryStorage(); const gate = deferred(); const fifo = serializedLock();
  const lock: HistoryLock = action => fifo(async () => { await gate.promise; return action(); });
  const history = controller(storage, lock);
  history.enqueue({ type: 'add', record: record() });
  await settled(); storage.value = 'unexpected format'; gate.release(); await settled();
  assert.equal(history.getSnapshot().status, 'corrupt');
  assert.equal(storage.value, 'unexpected format');
  assert.equal(history.getSnapshot().records.length, 1);
});

test('explicit reset wins over an older queued write while preserving genuinely new work', async () => {
  const storage = new MemoryStorage(); const gate = deferred(); const fifo = serializedLock();
  const lock: HistoryLock = action => fifo(async () => { await gate.promise; return action(); });
  const history = controller(storage, lock);
  history.enqueue({ type: 'add', record: record('before') }); await settled();
  history.reset(); history.enqueue({ type: 'add', record: record('after') });
  gate.release(); await settled();
  assert.equal(history.getSnapshot().status, 'saved');
  assert.deepEqual(parseHistory(storage.value).map(item => item.id), ['after']);
  assert.deepEqual(history.getSnapshot().records.map(item => item.id), ['after']);
});

test('failed explicit reset does not discard saved bytes or in-memory work', async () => {
  const storage = new MemoryStorage(); storage.value = '{broken';
  const history = controller(storage); history.start();
  history.enqueue({ type: 'add', record: record() }); storage.unavailable = true;
  history.reset(); await settled();
  assert.equal(history.getSnapshot().status, 'corrupt');
  assert.equal(history.getSnapshot().records.length, 1);
  assert.equal(storage.value, '{broken');
});

test('unsupported locks use memory and export rather than risking cross-tab overwrite', async () => {
  const storage = new MemoryStorage(); storage.value = serializeHistory([record('old')]);
  const history = createHistoryController({ getStorage: () => storage });
  history.enqueue({ type: 'add', record: record('new') }); await settled();
  assert.equal(history.getSnapshot().status, 'memory-only');
  assert.equal(storage.writes, 0);
  assert.equal(JSON.parse(history.exportJson()).records.length, 2);
  history.refresh();
  assert.equal(history.getSnapshot().records.length, 2);
});

test('temporary storage access failure retains new work until access and explicit retry recover', async () => {
  const storage = new MemoryStorage(); storage.value = serializeHistory([record('old')]); storage.unavailable = true;
  const history = controller(storage); history.enqueue({ type: 'add', record: record('new') });
  assert.equal(history.getSnapshot().status, 'error');
  storage.unavailable = false; history.retry(); await settled();
  assert.equal(history.getSnapshot().status, 'saved');
  assert.deepEqual(parseHistory(storage.value).map(item => item.id), ['new', 'old']);
});

test('new explanation and application arriving during a write are flushed after its accepted batch', async () => {
  const storage = new MemoryStorage(); const gate = deferred(); const fifo = serializedLock();
  const lock: HistoryLock = action => fifo(async () => { await gate.promise; return action(); });
  const history = controller(storage, lock);
  history.enqueue({ type: 'add', record: record() }); await settled();
  history.enqueue({ type: 'explanations', id: 'r1', values: [{ candidateId: 'r1-c1', error: 'EXPLANATION_INVALID' }] });
  history.enqueue({ type: 'apply', id: 'r1', candidateId: 'r1-c1', at });
  gate.release(); await settled();
  const saved = parseHistory(storage.value)[0];
  assert.equal(saved.appliedAt, at);
  assert.deepEqual(saved.explanations, [{ candidateId: 'r1-c1', error: 'EXPLANATION_INVALID' }]);
  assert.equal(history.getSnapshot().status, 'saved');
});

test('partial candidate explanation failure is retained separately from another successful explanation', async () => {
  const storage = new MemoryStorage(); const history = controller(storage);
  history.enqueue({ type: 'add', record: { ...record(), candidates: [
    { id: 'r1-c1', text: '후보 하나' }, { id: 'r1-c2', text: '후보 둘' },
  ] } });
  history.enqueue({ type: 'explanations', id: 'r1', values: [
    { candidateId: 'r1-c1', explanation: '후보 하나의 실제 설명' },
    { candidateId: 'r1-c2', error: 'EXPLANATION_QUOTE_MISMATCH' },
  ] });
  await settled();
  const saved = parseHistory(storage.value)[0].explanations;
  assert.equal(saved.length, 2);
  assert.ok('explanation' in saved[0]);
  assert.ok('error' in saved[1]);
});

test('oversized saved data is preserved and blocks new writes instead of being truncated', async () => {
  const storage = new MemoryStorage(); storage.value = 'x'.repeat(HISTORY_MAX_BYTES / 2 + 1);
  const original = storage.value; const history = controller(storage);
  history.enqueue({ type: 'add', record: record() }); await settled();
  assert.equal(history.getSnapshot().status, 'corrupt');
  assert.equal(storage.value, original);
  assert.equal(storage.writes, 0);
  assert.equal(history.getSnapshot().records.length, 1);
});

test('lock failure keeps the current record and reports failure without modifying storage', async () => {
  const storage = new MemoryStorage();
  const lock: HistoryLock = async () => { throw new Error('lock failed'); };
  const history = controller(storage, lock);
  history.enqueue({ type: 'add', record: record() }); await settled();
  assert.equal(history.getSnapshot().status, 'error');
  assert.equal(storage.value, null);
  assert.equal(JSON.parse(history.exportJson()).records[0].id, 'r1');
});
