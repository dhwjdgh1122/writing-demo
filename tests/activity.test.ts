import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_KEY, ACTIVITY_PARTICIPANT_KEY, ACTIVITY_MAX_BYTES, activityErrorCode, activityRequirementStats, activityStats, appendActivity, createActivityController,
  loadActivityParticipant, saveActivityParticipant,
  csvCell, exportActivityCsv, exportActivityJson, parseActivity, serializeActivity, type ActivityEvent } from '../client/src/lib/activity.js';
import type { HistoryLock, HistoryRecord, HistoryStorage } from '../client/src/lib/history.js';

const at = '2026-11-21T06:00:00.000Z';
const event = (id = 'e1', changes: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id, at, participantCode: 'T01', sessionId: 'session-1', requestId: `r-${id}`, action: 'correction_requested', ...changes,
});
const history: HistoryRecord = { id: 'r-e1', createdAt: at, sourceText: '=FORMULA_PRIVATE_SOURCE',
  candidates: [{ id: 'candidate-1', text: 'PRIVATE_CANDIDATE' }], explanations: [{ candidateId: 'candidate-1', explanation: 'PRIVATE_EXPLANATION' }],
  appliedCandidateId: null, appliedAt: null };
class MemoryStorage implements HistoryStorage {
  value: string | null = null;
  failWrite = false;
  failRead = false;
  writes = 0;
  getItem(key: string) { assert.equal(key, ACTIVITY_KEY); if (this.failRead) throw new Error('unavailable'); return this.value; }
  setItem(key: string, value: string) { assert.equal(key, ACTIVITY_KEY); if (this.failWrite) throw new Error('quota'); this.value = value; this.writes++; }
  removeItem(key: string) { assert.equal(key, ACTIVITY_KEY); if (this.failWrite) throw new Error('unavailable'); this.value = null; }
}
function lock(): HistoryLock {
  let tail: Promise<unknown> = Promise.resolve();
  return action => { const next = tail.then(action); tail = next.catch(() => undefined); return next; };
}
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const controller = (storage: MemoryStorage, mutex: HistoryLock | undefined = lock()) => createActivityController({ getStorage: () => storage, lock: mutex });

test('activity documents preserve metadata only and reject unknown text, versions, duplicate IDs and unsafe identifiers', () => {
  assert.deepEqual(parseActivity(serializeActivity([event()])), [event()]);
  assert.deepEqual(parseActivity(null), []);
  const invalid = [
    { version: 2, events: [] }, { version: 1, events: [event(), event()] },
    { version: 1, events: [{ ...event(), sourceText: 'private sentence' }] },
    { version: 1, events: [{ ...event(), errorCode: 'https://secret.test/token' }] },
    { version: 1, events: [{ ...event(), participantCode: 'name@example.com' }] },
    { version: 1, events: [{ ...event(), requestId: 'https://secret.test' }] },
    { version: 1, events: [{ ...event(), parentRequestId: 'r-e1' }] },
  ];
  for (const value of invalid) assert.throws(() => parseActivity(JSON.stringify(value)));
  assert.throws(() => parseActivity('{broken'));
  assert.throws(() => parseActivity('x'.repeat(ACTIVITY_MAX_BYTES / 2 + 1)));
  assert.equal(activityErrorCode('MODEL_OUTPUT_TRUNCATED'), 'MODEL_OUTPUT_TRUNCATED');
  assert.equal(activityErrorCode('secret raw error'), 'UNKNOWN_ERROR');
});

test('duplicate callbacks are ignored but distinct explanation attempts remain separate', () => {
  const original = event('a', { requestId: 'request', action: 'explanation_requested', attemptId: 'attempt1' });
  const first = appendActivity([], original);
  assert.equal(appendActivity(first, original), first);
  assert.equal(appendActivity(first, { ...original, id: 'b', at: '2026-11-21T06:01:00.000Z', participantCode: 'T02' }), first);
  assert.equal(appendActivity(first, { ...original, id: 'c', attemptId: 'attempt2' }).length, 2);
  assert.equal(first[0].participantCode, 'T01');
});

test('default exports contain no sentence data and optional exports join only remaining history by request ID', () => {
  const events = [event(), event('other')];
  for (const output of [exportActivityJson(events, [history]), exportActivityCsv(events, [history])]) {
    for (const privateValue of ['FORMULA_PRIVATE_SOURCE', 'PRIVATE_CANDIDATE', 'PRIVATE_EXPLANATION']) assert.ok(!output.includes(privateValue));
    assert.ok(!output.includes('sourceText'));
  }
  const included = JSON.parse(exportActivityJson(events, [history], true));
  assert.equal(included.contentIncluded, true);
  assert.equal(included.events[0].content.sourceText, history.sourceText);
  assert.ok(!('content' in included.events[1]));
  const deleted = JSON.parse(exportActivityJson(events, [], true));
  assert.equal(deleted.events.length, 2);
  assert.ok(deleted.events.every((item: object) => !('content' in item)));
  assert.ok(!exportActivityCsv(events, [], true).includes('PRIVATE_'));
});

test('CSV quotes commas, quotes and newlines and neutralizes formula prefixes in optional text', () => {
  assert.equal(csvCell('plain,"quote"\nnext'), '"plain,""quote""\nnext"');
  for (const value of ['=1+1', '+SUM(A1)', '-1+2', '@x', '  =1', '\tformula', '\nformula']) {
    assert.ok(csvCell(value).startsWith('"\''));
  }
  const csv = exportActivityCsv([event()], [history], true);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=FORMULA_PRIVATE_SOURCE"'));
  assert.ok(csv.includes('"sourceText"'));
});

test('rerun statistics use distinct received request denominators and allow applied/rerequested overlap', () => {
  const events = [
    event('a', { requestId: 'initial' }),
    event('b', { requestId: 'r1', parentRequestId: 'initial' }),
    event('c', { requestId: 'r1', action: 'correction_received' }),
    event('d', { requestId: 'r1', action: 'candidate_applied', candidateId: 'c1' }),
    event('e', { requestId: 'r1', action: 'candidate_applied', candidateId: 'c1' }),
    event('f', { requestId: 'r2', parentRequestId: 'r1' }),
    event('g', { requestId: 'r2', action: 'correction_received' }),
    event('h', { requestId: 'failed', parentRequestId: 'initial' }),
    event('i', { requestId: 'failed', action: 'correction_failed', errorCode: 'MODEL_OUTPUT_TRUNCATED' }),
    event('j', { requestId: 'unrelated', action: 'candidate_applied' }),
  ];
  assert.deepEqual(activityStats(events), { requested: 4, reruns: 3, receivedReruns: 2, appliedReruns: 1, rerequestedReruns: 1 });
});

test('two controllers merge latest stored events inside the shared lock and cross-tab refresh updates the snapshot', async () => {
  const storage = new MemoryStorage(); const mutex = lock();
  const first = controller(storage, mutex); const second = controller(storage, mutex);
  first.start(); second.start(); first.add(event('a')); second.add(event('b'));
  await drain();
  assert.deepEqual(parseActivity(storage.value).map(item => item.id), ['a', 'b']);
  first.refresh(); second.refresh();
  assert.deepEqual(first.getSnapshot().events, second.getSnapshot().events);
  assert.equal(first.getSnapshot().status, 'saved');
  const writes = storage.writes; first.add(event('a')); await drain(); assert.equal(storage.writes, writes);
});

test('clear is serialized against latest storage and a stale tab cannot reintroduce old acknowledged events', async () => {
  const storage = new MemoryStorage(); const mutex = lock();
  storage.value = serializeActivity([event('old')]);
  const first = controller(storage, mutex); const second = controller(storage, mutex);
  first.start(); second.start(); first.clear(); await drain();
  second.add(event('new')); await drain();
  assert.deepEqual(parseActivity(storage.value).map(item => item.id), ['new']);
  first.refresh(); assert.equal(first.getSnapshot().events[0].id, 'new');
});

test('quota failure preserves pending events for export and retry merges latest other-tab activity', async () => {
  const storage = new MemoryStorage(); storage.value = serializeActivity([event('old')]); storage.failWrite = true;
  const activity = controller(storage); activity.add(event('pending')); await drain();
  assert.equal(activity.getSnapshot().status, 'error');
  assert.equal(JSON.parse(activity.exportJson()).events.length, 2);
  assert.equal(parseActivity(storage.value).length, 1);
  storage.value = serializeActivity([event('old'), event('other-tab')]); storage.failWrite = false;
  activity.retry(); await drain();
  assert.equal(activity.getSnapshot().status, 'saved');
  assert.deepEqual(parseActivity(storage.value).map(item => item.id), ['old', 'other-tab', 'pending']);
});

test('corrupt storage is not overwritten by record, clear, retry or refresh; only explicit reset replaces it', async () => {
  const storage = new MemoryStorage(); storage.value = '{broken';
  const activity = controller(storage); activity.start(); activity.add(event());
  assert.equal(activity.getSnapshot().status, 'corrupt');
  assert.equal(JSON.parse(activity.exportJson()).events.length, 1);
  activity.clear(); activity.retry(); activity.refresh(); await drain();
  assert.equal(storage.value, '{broken'); assert.equal(storage.writes, 0);
  activity.reset(); await drain(); assert.equal(storage.value, null);
  activity.add(event('after')); await drain(); assert.equal(parseActivity(storage.value)[0].id, 'after');
});

test('reset wins over an older pending write and retains newly recorded events', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const fifo = lock();
  const delayed: HistoryLock = action => fifo(async () => { await gate; return action(); });
  const storage = new MemoryStorage(); const activity = controller(storage, delayed);
  activity.add(event('before')); await drain();
  activity.reset(); activity.add(event('after')); release(); await drain();
  assert.equal(activity.getSnapshot().status, 'saved');
  assert.deepEqual(parseActivity(storage.value).map(item => item.id), ['after']);
});

test('temporary read failures and unsupported locks keep metadata exportable without unsafe writes', async () => {
  const storage = new MemoryStorage(); storage.failRead = true;
  const activity = controller(storage); activity.add(event());
  assert.equal(activity.getSnapshot().status, 'error');
  storage.failRead = false; activity.retry(); await drain(); assert.equal(activity.getSnapshot().status, 'saved');
  const withoutLocks = createActivityController({ getStorage: () => storage });
  withoutLocks.add(event('memory')); await drain();
  assert.equal(withoutLocks.getSnapshot().status, 'memory-only');
  assert.equal(JSON.parse(withoutLocks.exportJson()).events.length, 2);
  assert.equal(parseActivity(storage.value).length, 1);
});

test('invalid record input cannot put source text or arbitrary error strings in storage or export', async () => {
  const storage = new MemoryStorage(); const activity = controller(storage);
  activity.add({ ...event(), sourceText: 'SECRET' } as ActivityEvent);
  await drain();
  assert.equal(activity.getSnapshot().events.length, 0);
  assert.equal(storage.value, null);
  assert.ok(!activity.exportJson().includes('SECRET'));
});

test('participant label persists separately, preserves past event labels, and reports unavailable storage', () => {
  const values = new Map<string, string>();
  const storage: HistoryStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  assert.equal(loadActivityParticipant(() => storage, 'T-initial').code, 'T-initial');
  assert.equal(loadActivityParticipant(() => storage, 'T-other').code, 'T-initial');
  const previous = event('old', { participantCode: 'T-initial' });
  assert.equal(saveActivityParticipant(() => storage, 'TEAM02'), null);
  assert.equal(loadActivityParticipant(() => storage, 'T-other').code, 'TEAM02');
  assert.equal(previous.participantCode, 'T-initial');
  assert.equal(values.has(ACTIVITY_KEY), false);
  assert.throws(() => saveActivityParticipant(() => storage, 'private@email.com'));
  values.set(ACTIVITY_PARTICIPANT_KEY, 'corrupt-setting');
  const corrupt = loadActivityParticipant(() => storage, 'T-local');
  assert.equal(corrupt.code, 'T-local'); assert.ok(corrupt.error);
  assert.equal(values.get(ACTIVITY_PARTICIPANT_KEY), 'corrupt-setting');
  const unavailable = () => { throw new Error('unavailable'); };
  assert.ok(loadActivityParticipant(unavailable, 'T-local').error);
  assert.ok(saveActivityParticipant(unavailable, 'T-local'));
});

test('requirement groups count distinct rerun requests and received denominators across participant labels', () => {
  const events = [
    event('a', { requestId: 'r1', parentRequestId: 'p1', requirement: 'polite' }),
    event('b', { requestId: 'r1', parentRequestId: 'p1', requirement: 'polite' }),
    event('c', { requestId: 'r1', action: 'correction_received' }),
    event('d', { requestId: 'r1', action: 'candidate_applied' }),
    event('e', { requestId: 'r1', action: 'candidate_applied' }),
    event('f', { requestId: 'r2', parentRequestId: 'p2', requirement: 'polite', participantCode: 'T02' }),
    event('g', { requestId: 'r2', action: 'correction_failed' }),
    event('h', { requestId: 'r3', parentRequestId: 'p3' }),
    event('i', { requestId: 'r3', action: 'correction_cancelled' }),
    event('j', { requestId: 'r3', action: 'correction_cancelled' }),
  ];
  const rows = activityRequirementStats(events);
  assert.deepEqual(rows.find(row => row.key === 'polite'), { key: 'polite', label: '더 정중하게', requested: 2, received: 1, failed: 1, cancelled: 0, applied: 1 });
  assert.deepEqual(rows.find(row => row.key === 'not_selected'), { key: 'not_selected', label: '요구 선택 안 함', requested: 1, received: 0, failed: 0, cancelled: 1, applied: 0 });
  assert.equal(rows.find(row => row.key === 'alternative')!.requested, 0);
});

test('partial logs after clearing do not invent missing requests, requirements, received parents or application denominators', () => {
  const partial = [
    event('a', { requestId: 'deleted-rerun', action: 'correction_received', parentRequestId: 'deleted-parent', requirement: 'meaning' }),
    event('b', { requestId: 'deleted-rerun', action: 'candidate_applied' }),
    event('c', { requestId: 'new-rerun', parentRequestId: 'deleted-rerun', requirement: 'errors' }),
    event('d', { requestId: 'new-rerun', action: 'candidate_applied' }),
  ];
  assert.deepEqual(activityStats(partial), { requested: 1, reruns: 1, receivedReruns: 0, appliedReruns: 0, rerequestedReruns: 0 });
  const rows = activityRequirementStats(partial);
  assert.equal(rows.find(row => row.key === 'meaning')!.requested, 0);
  assert.deepEqual(rows.find(row => row.key === 'errors'), { key: 'errors', label: '남은 오류 확인', requested: 1, received: 0, failed: 0, cancelled: 0, applied: 0 });
});
