import { z } from 'zod';
import { correctionInputSchema, correctionOutputSchema, explanationResultsSchema, requestIdSchema, retryRequirementSchema, type Candidate, type ExplanationResult, type RetryRequirement } from '../../../shared/contracts';

export type HistoryRecord = {
  id: string; createdAt: string; sourceText: string; candidates: Candidate[];
  explanations: ExplanationResult[]; appliedCandidateId: string | null; appliedAt: string | null;
  parentRecordId?: string;
  targetCandidate?: Candidate;
  phase?: 'before_apply' | 'after_apply'; requirement?: RetryRequirement;
};
export type HistoryOperation =
  | { type: 'add'; record: HistoryRecord }
  | { type: 'explanations'; id: string; values: ExplanationResult[] }
  | { type: 'apply'; id: string; candidateId: string; at: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' };
export type HistoryStatus = 'loading' | 'saved' | 'saving' | 'memory-only' | 'error' | 'corrupt';
export type HistorySnapshot = { records: HistoryRecord[]; status: HistoryStatus; error: string | null };
export const HISTORY_KEY = 'writing-demo.correction-history.v1';
export const HISTORY_LOCK = 'writing-demo.correction-history';
// Read/serialization safety guards, not an automatic retention/deletion policy.
export const HISTORY_MAX_RECORDS = 5_000;
export const HISTORY_MAX_BYTES = 10 * 1024 * 1024;
const timestamp = z.string().datetime();
const explanationValues = z.array(explanationResultsSchema.element).max(3)
  .refine(values => new Set(values.map(value => value.candidateId)).size === values.length);
const recordSchema = z.object({
  id: requestIdSchema, createdAt: timestamp, sourceText: correctionInputSchema.shape.sourceText,
  candidates: correctionOutputSchema.shape.candidates, explanations: explanationValues,
  appliedCandidateId: requestIdSchema.nullable(), appliedAt: timestamp.nullable(), parentRecordId: requestIdSchema.optional(),
  targetCandidate: correctionInputSchema.shape.targetCandidate,
  phase: z.enum(['before_apply', 'after_apply']).optional(), requirement: retryRequirementSchema.optional(),
}).strict().refine(record => record.explanations.every(value => record.candidates.some(candidate => candidate.id === value.candidateId))
  && (record.appliedCandidateId === null ? record.appliedAt === null
    : record.appliedAt !== null && record.candidates.some(candidate => candidate.id === record.appliedCandidateId))
  && record.parentRecordId !== record.id);
const documentSchema = z.object({
  version: z.literal(1), records: z.array(recordSchema).max(HISTORY_MAX_RECORDS)
    .refine(records => new Set(records.map(record => record.id)).size === records.length),
}).strict();
const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add'), record: recordSchema }).strict(),
  z.object({ type: z.literal('explanations'), id: requestIdSchema, values: explanationValues }).strict(),
  z.object({ type: z.literal('apply'), id: requestIdSchema, candidateId: requestIdSchema, at: timestamp }).strict(),
  z.object({ type: z.literal('remove'), id: requestIdSchema }).strict(),
  z.object({ type: z.literal('clear') }).strict(),
]);

export function parseHistory(raw: string | null): HistoryRecord[] {
  if (raw === null) return [];
  if (raw.length * 2 > HISTORY_MAX_BYTES) throw new Error('History exceeds the safe read size.');
  const parsed = documentSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('Invalid history document.');
  return parsed.data.records;
}

export function serializeHistory(records: HistoryRecord[]): string {
  const raw = JSON.stringify(documentSchema.parse({ version: 1, records }));
  if (raw.length * 2 > HISTORY_MAX_BYTES) throw new Error('History exceeds the safe write size.');
  return raw;
}

/** Immutable and idempotent: only add creates a record; late patches never recreate one. */
export function applyHistoryOperation(records: HistoryRecord[], input: HistoryOperation): HistoryRecord[] {
  const operation = operationSchema.parse(input);
  if (operation.type === 'clear') return records.length ? [] : records;
  if (operation.type === 'add') return records.some(record => record.id === operation.record.id) ? records : [operation.record, ...records];
  const index = records.findIndex(record => record.id === operation.id);
  if (index === -1) return records;
  if (operation.type === 'remove') return records.filter(record => record.id !== operation.id);
  const record = records[index];
  let updated: HistoryRecord;
  if (operation.type === 'apply') {
    if (!record.candidates.some(candidate => candidate.id === operation.candidateId)
      || record.appliedCandidateId === operation.candidateId && record.appliedAt === operation.at
      || record.appliedAt && Date.parse(operation.at) < Date.parse(record.appliedAt)) return records;
    updated = { ...record, appliedCandidateId: operation.candidateId, appliedAt: operation.at };
  } else {
    if (!operation.values.every(value => record.candidates.some(candidate => candidate.id === value.candidateId))) return records;
    const values = new Map(record.explanations.map(value => [value.candidateId, value]));
    for (const value of operation.values) {
      // A failed retry must not erase an explanation that was already received.
      const previous = values.get(value.candidateId);
      if (previous && 'explanation' in previous && 'error' in value) continue;
      values.set(value.candidateId, value);
    }
    const explanations = record.candidates.flatMap(candidate => values.has(candidate.id) ? [values.get(candidate.id)!] : []);
    if (JSON.stringify(explanations) === JSON.stringify(record.explanations)) return records;
    updated = { ...record, explanations };
  }
  return records.map((item, position) => position === index ? updated : item);
}

export type HistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type HistoryLock = <T>(action: () => T | Promise<T>) => Promise<T>;
export type HistoryController = ReturnType<typeof createHistoryController>;
type Queued = { sequence: number; operation: HistoryOperation };
class CorruptHistory extends Error {}

export function createHistoryController(options: { getStorage: () => HistoryStorage; lock?: HistoryLock }) {
  let snapshot: HistorySnapshot = { records: [], status: 'loading', error: null };
  let stored: HistoryRecord[] = [];
  let pending: Queued[] = [];
  let sequence = 0;
  let epoch = 0;
  let started = false;
  let writing = false;
  let resetting = false;
  let blocked = false;
  let failed = false;
  let refreshNeeded = false;
  const listeners = new Set<() => void>();
  const publish = (records: HistoryRecord[], status: HistoryStatus, error: string | null) => {
    snapshot = { records, status, error };
    for (const listener of listeners) listener();
  };
  const replay = (base: HistoryRecord[], queue = pending) => queue.reduce((records, item) => applyHistoryOperation(records, item.operation), base);
  const read = () => {
    const raw = options.getStorage().getItem(HISTORY_KEY);
    try { return parseHistory(raw); }
    catch { throw new CorruptHistory(); }
  };
  const memoryMessage = '이 브라우저에서는 안전한 자동 저장을 사용할 수 없습니다. 기록은 현재 창에만 남으며 JSON으로 내보낼 수 있습니다.';
  const corruptMessage = '저장된 교정 이력을 읽을 수 없어 원래 데이터를 보존하고 자동 저장을 멈췄습니다. 현재 목록을 내보내거나 저장 데이터를 명시적으로 초기화해주세요.';
  const writeMessage = '브라우저에 교정 이력을 저장하지 못했습니다. 현재 창의 기록은 유지됩니다. JSON으로 내보내거나 일부 기록을 삭제한 뒤 저장을 다시 시도해주세요.';

  function refresh() {
    if (writing || resetting) { refreshNeeded = true; return; }
    if (blocked) return; // Only an explicit reset may replace unreadable saved bytes.
    try {
      stored = read();
      const records = replay(stored);
      publish(records, !options.lock ? 'memory-only' : failed ? 'error' : pending.length ? 'saving' : 'saved',
        !options.lock ? memoryMessage : failed ? writeMessage : null);
      schedule();
    } catch (error) {
      if (error instanceof CorruptHistory) { blocked = true; publish(snapshot.records, 'corrupt', corruptMessage); }
      else { failed = true; publish(snapshot.records, 'error', writeMessage); }
    }
  }

  function start() {
    if (started) return;
    started = true;
    refresh();
  }

  function schedule() {
    if (!pending.length || writing || resetting || blocked || failed || !options.lock) return;
    queueMicrotask(() => { void flush(); });
  }

  async function flush() {
    if (!pending.length || writing || resetting || blocked || failed || !options.lock) return;
    writing = true;
    const ownEpoch = epoch;
    const batch = [...pending];
    try {
      const next = await options.lock(() => {
        const latest = read();
        const records = replay(latest, batch);
        if (records !== latest) options.getStorage().setItem(HISTORY_KEY, serializeHistory(records));
        return records;
      });
      if (ownEpoch !== epoch) return;
      stored = next;
      const lastSequence = batch[batch.length - 1].sequence;
      pending = pending.filter(item => item.sequence > lastSequence);
      publish(replay(stored), pending.length ? 'saving' : 'saved', null);
    } catch (error) {
      if (ownEpoch !== epoch) return;
      if (error instanceof CorruptHistory) { blocked = true; publish(snapshot.records, 'corrupt', corruptMessage); }
      else { failed = true; publish(snapshot.records, 'error', writeMessage); }
    } finally {
      writing = false;
      if (refreshNeeded && !resetting) { refreshNeeded = false; refresh(); }
      schedule();
    }
  }

  function enqueue(operation: HistoryOperation) {
    start();
    try {
      const safe = operationSchema.parse(operation);
      const records = applyHistoryOperation(snapshot.records, safe);
      if (records === snapshot.records) return;
      pending.push({ sequence: ++sequence, operation: safe });
      publish(records, blocked ? 'corrupt' : !options.lock ? 'memory-only' : failed ? 'error' : 'saving',
        blocked ? corruptMessage : !options.lock ? memoryMessage : failed ? writeMessage : null);
      schedule();
    } catch {
      publish(snapshot.records, 'error', '교정 이력의 연결 정보를 확인하지 못해 이 변경을 저장하지 않았습니다.');
    }
  }

  function retry() {
    start();
    if (blocked) return;
    failed = false;
    refresh();
  }

  function reset() {
    start();
    if (resetting) return;
    if (!options.lock) { publish(snapshot.records, 'memory-only', memoryMessage); return; }
    resetting = true;
    const cutoff = sequence;
    ++epoch; // Ignore completion of a write that started before this explicit reset.
    publish(snapshot.records, 'saving', null);
    void options.lock(() => options.getStorage().removeItem(HISTORY_KEY)).then(() => {
      stored = [];
      pending = pending.filter(item => item.sequence > cutoff);
      blocked = false;
      failed = false;
      publish(replay(stored), pending.length ? 'saving' : 'saved', null);
    }).catch(() => {
      failed = true;
      publish(snapshot.records, blocked ? 'corrupt' : 'error', '저장된 교정 이력을 초기화하지 못했습니다. 기존 기록은 유지됩니다. 브라우저 저장소 접근을 확인한 뒤 다시 시도해주세요.');
    }).finally(() => {
      resetting = false;
      if (refreshNeeded && !writing) { refreshNeeded = false; refresh(); }
      schedule();
    });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, refresh, enqueue, retry, reset,
    remove: (id: string) => enqueue({ type: 'remove', id }),
    clear: () => enqueue({ type: 'clear' }),
    exportJson: () => JSON.stringify({ version: 1, records: snapshot.records }, null, 2),
  };
}
