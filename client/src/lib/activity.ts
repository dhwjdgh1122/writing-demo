import { z } from 'zod';
import { requestIdSchema } from '../../../shared/contracts';
import type { HistoryRecord, HistoryLock, HistoryStorage, HistoryStatus } from './history';

export const ACTIVITY_KEY = 'writing-demo.activity.v1';
export const ACTIVITY_LOCK = 'writing-demo.activity';
export const ACTIVITY_PARTICIPANT_KEY = 'writing-demo.activity-participant.v1';
export const ACTIVITY_MAX_EVENTS = 30_000;
export const ACTIVITY_MAX_BYTES = 10 * 1024 * 1024;
export const participantCodeSchema = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);
const participantDocument = z.object({ version: z.literal(1), participantCode: participantCodeSchema }).strict();
const participantStorageError = '참여자 코드를 브라우저에 저장하지 못했습니다. 현재 창에서만 사용하며 새로고침 후 같은 코드를 다시 입력해주세요.';
export function loadActivityParticipant(getStorage: () => HistoryStorage, fallback: string): { code: string; error: string | null } {
  const code = participantCodeSchema.parse(fallback);
  try {
    const storage = getStorage();
    const raw = storage.getItem(ACTIVITY_PARTICIPANT_KEY);
    if (raw !== null) {
      if (raw.length > 500) throw new Error('Invalid participant setting.');
      return { code: participantDocument.parse(JSON.parse(raw)).participantCode, error: null };
    }
    storage.setItem(ACTIVITY_PARTICIPANT_KEY, JSON.stringify({ version: 1, participantCode: code }));
    return { code, error: null };
  } catch { return { code, error: participantStorageError }; }
}
export function saveActivityParticipant(getStorage: () => HistoryStorage, code: string): string | null {
  const participantCode = participantCodeSchema.parse(code);
  try { getStorage().setItem(ACTIVITY_PARTICIPANT_KEY, JSON.stringify({ version: 1, participantCode })); return null; }
  catch { return participantStorageError; }
}
const actions = ['correction_requested', 'correction_received', 'correction_failed', 'correction_cancelled',
  'explanation_requested', 'explanation_received', 'explanation_failed', 'explanation_cancelled', 'candidate_applied'] as const;
const errorCodes = ['INVALID_INPUT', 'MODEL_NOT_CONFIGURED', 'MODEL_RESPONSE_INVALID', 'MODEL_OUTPUT_TRUNCATED',
  'EXPLANATION_QUOTE_MISMATCH', 'EXPLANATION_INVALID', 'MODEL_REQUEST_FAILED', 'MODEL_TIMEOUT', 'MODEL_CONFIGURATION_ERROR',
  'MODEL_QUOTA_EXCEEDED', 'MODEL_BLOCKED', 'MODEL_UNAVAILABLE', 'NOT_FOUND', 'NETWORK_ERROR', 'UNKNOWN_ERROR',
  'CLIENT_RESPONSE_INVALID', 'CLIENT_REQUEST_FAILED', 'CLIENT_TIMEOUT'] as const;
const errorCodeSchema = z.enum(errorCodes);
const eventSchema = z.object({
  id: requestIdSchema, at: z.string().datetime(), participantCode: participantCodeSchema, sessionId: requestIdSchema,
  requestId: requestIdSchema, parentRequestId: requestIdSchema.optional(),
  targetCandidateId: requestIdSchema.optional(),
  phase: z.enum(['before_apply', 'after_apply']).optional(),
  requirement: z.enum(['alternative', 'polite', 'plain', 'meaning', 'errors']).optional(),
  action: z.enum(actions), candidateId: requestIdSchema.optional(), attemptId: requestIdSchema.optional(),
  errorCode: errorCodeSchema.optional(),
}).strict().refine(event => event.parentRequestId !== event.requestId);
export type ActivityEvent = z.infer<typeof eventSchema>;
export type ActivityInput = Omit<ActivityEvent, 'id' | 'at' | 'participantCode' | 'sessionId'>;
export type ActivitySnapshot = { events: ActivityEvent[]; status: HistoryStatus; error: string | null };
type Operation = { type: 'add'; event: ActivityEvent } | { type: 'clear' };
const documentSchema = z.object({ version: z.literal(1), events: z.array(eventSchema).max(ACTIVITY_MAX_EVENTS)
  .refine(events => new Set(events.map(event => event.id)).size === events.length) }).strict();

/** Error messages, URLs and arbitrary caller strings must never become telemetry. */
export function activityErrorCode(value: unknown): ActivityEvent['errorCode'] {
  const parsed = errorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'UNKNOWN_ERROR';
}

export function parseActivity(raw: string | null): ActivityEvent[] {
  if (raw === null) return [];
  if (raw.length * 2 > ACTIVITY_MAX_BYTES) throw new Error('Activity exceeds safe read size.');
  return documentSchema.parse(JSON.parse(raw)).events;
}
export function serializeActivity(events: ActivityEvent[]): string {
  const raw = JSON.stringify(documentSchema.parse({ version: 1, events }));
  if (raw.length * 2 > ACTIVITY_MAX_BYTES) throw new Error('Activity exceeds safe write size.');
  return raw;
}

const logicalKey = (event: ActivityEvent) => JSON.stringify([
  event.sessionId, event.requestId, event.action, event.attemptId ?? '', event.candidateId ?? '',
]);
export function appendActivity(events: ActivityEvent[], input: ActivityEvent): ActivityEvent[] {
  const event = eventSchema.parse(input);
  if (events.some(previous => previous.id === event.id || logicalKey(previous) === logicalKey(event))) return events;
  return [...events, event];
}

/** Metadata is immutable. Optional content is joined only from history still present at export time. */
function exportRows(events: ActivityEvent[], records: HistoryRecord[], includeContent: boolean) {
  const current = new Map(records.map(record => [record.id, record]));
  return events.map(event => {
    const safe = eventSchema.parse(event);
    const record = includeContent ? current.get(event.requestId) : undefined;
    return record ? { ...safe, content: { sourceText: record.sourceText, candidates: record.candidates,
      explanations: record.explanations } } : safe;
  });
}
export function exportActivityJson(events: ActivityEvent[], records: HistoryRecord[] = [], includeContent = false) {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), contentIncluded: includeContent,
    events: exportRows(events, records, includeContent) }, null, 2);
}
/** Quote every field and neutralize spreadsheet formula prefixes, including after whitespace. */
export function csvCell(value: unknown) {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function exportActivityCsv(events: ActivityEvent[], records: HistoryRecord[] = [], includeContent = false) {
  const headers = ['id', 'at', 'participantCode', 'sessionId', 'requestId', 'parentRequestId', 'targetCandidateId', 'phase', 'requirement',
    'action', 'candidateId', 'attemptId', 'errorCode', ...(includeContent ? ['sourceText', 'candidates', 'explanations'] : [])];
  const lines = exportRows(events, records, includeContent).map(event => {
    const row: Record<string, unknown> = { ...event };
    if ('content' in event) {
      row.sourceText = event.content.sourceText;
      row.candidates = JSON.stringify(event.content.candidates);
      row.explanations = JSON.stringify(event.content.explanations);
    }
    return headers.map(key => csvCell(row[key])).join(',');
  });
  return '\uFEFF' + [headers.map(csvCell).join(','), ...lines].join('\r\n');
}

/** Counts requests, not clicks; applying is not evidence of satisfaction or explanation benefit. */
export function activityStats(events: ActivityEvent[]) {
  const requested = new Set(events.filter(event => event.action === 'correction_requested').map(event => event.requestId));
  const reruns = new Set(events.filter(event => event.action === 'correction_requested' && event.parentRequestId).map(event => event.requestId));
  const received = new Set(events.filter(event => event.action === 'correction_received').map(event => event.requestId));
  const receivedReruns = new Set([...reruns].filter(id => received.has(id)));
  const applied = new Set(events.filter(event => event.action === 'candidate_applied' && receivedReruns.has(event.requestId)).map(event => event.requestId));
  const rerequested = new Set(events.filter(event => event.action === 'correction_requested' && event.parentRequestId
    && receivedReruns.has(event.parentRequestId)).map(event => event.parentRequestId!));
  return { requested: requested.size, reruns: reruns.size, receivedReruns: receivedReruns.size,
    appliedReruns: applied.size, rerequestedReruns: rerequested.size };
}

export const ACTIVITY_REQUIREMENTS = [
  { key: 'alternative', label: '다른 표현' }, { key: 'polite', label: '더 정중하게' },
  { key: 'plain', label: '더 담백하게' }, { key: 'meaning', label: '원래 뜻 유지' },
  { key: 'errors', label: '남은 오류 확인' }, { key: 'not_selected', label: '요구 선택 안 함' },
] as const;
export function activityRequirementStats(events: ActivityEvent[]) {
  const requested = new Map<string, ActivityEvent>();
  for (const event of events) {
    // A response alone cannot reconstruct a deleted request or its requirement.
    if (event.action === 'correction_requested' && event.parentRequestId && !requested.has(event.requestId)) requested.set(event.requestId, event);
  }
  const idsFor = (action: ActivityEvent['action']) => new Set(events.filter(event => event.action === action).map(event => event.requestId));
  const received = idsFor('correction_received');
  const failed = idsFor('correction_failed');
  const cancelled = idsFor('correction_cancelled');
  const applied = idsFor('candidate_applied');
  return ACTIVITY_REQUIREMENTS.map(({ key, label }) => {
    const ids = [...requested].filter(([, event]) => (event.requirement ?? 'not_selected') === key).map(([id]) => id);
    return { key, label, requested: ids.length, received: ids.filter(id => received.has(id)).length,
      failed: ids.filter(id => failed.has(id)).length, cancelled: ids.filter(id => cancelled.has(id)).length,
      applied: ids.filter(id => received.has(id) && applied.has(id)).length };
  });
}

type Queued = { sequence: number; operation: Operation };
class CorruptActivity extends Error {}
export function createActivityController(options: { getStorage: () => HistoryStorage; lock?: HistoryLock }) {
  let snapshot: ActivitySnapshot = { events: [], status: 'loading', error: null };
  let stored: ActivityEvent[] = [];
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
  const memoryMessage = '이 브라우저에서는 안전한 자동 저장을 사용할 수 없습니다. 기록은 현재 창에만 남으며 내보낼 수 있습니다.';
  const messages = {
    corrupt: '저장된 행동 기록을 읽을 수 없어 원래 데이터를 보존하고 자동 저장을 멈췄습니다. 필요한 현재 기록을 내보낸 뒤 저장소를 초기화해주세요.',
    failed: '행동 기록을 저장하지 못했습니다. 현재 창의 기록은 유지됩니다. 내보내거나 저장을 다시 시도해주세요.',
  };
  const publish = (events: ActivityEvent[], status: HistoryStatus, error: string | null) => {
    snapshot = { events, status, error };
    for (const listener of listeners) listener();
  };
  const replay = (base: ActivityEvent[], queue = pending) => queue.reduce((events, item) =>
    item.operation.type === 'clear' ? [] : appendActivity(events, item.operation.event), base);
  const read = () => {
    const raw = options.getStorage().getItem(ACTIVITY_KEY);
    try { return parseActivity(raw); } catch { throw new CorruptActivity(); }
  };
  const currentStatus = (): HistoryStatus => blocked ? 'corrupt' : !options.lock ? 'memory-only' : failed ? 'error' : pending.length ? 'saving' : 'saved';
  const currentMessage = () => blocked ? messages.corrupt : !options.lock ? memoryMessage : failed ? messages.failed : null;
  function refresh() {
    if (writing || resetting) { refreshNeeded = true; return; }
    if (blocked) return;
    try { stored = read(); publish(replay(stored), currentStatus(), currentMessage()); schedule(); }
    catch (error) {
      if (error instanceof CorruptActivity) blocked = true; else failed = true;
      publish(snapshot.events, currentStatus(), currentMessage());
    }
  }
  function start() { if (!started) { started = true; refresh(); } }
  function schedule() {
    if (pending.length && !writing && !resetting && !blocked && !failed && options.lock) queueMicrotask(() => { void flush(); });
  }
  async function flush() {
    if (!pending.length || writing || resetting || blocked || failed || !options.lock) return;
    writing = true;
    const ownEpoch = epoch;
    const batch = [...pending];
    try {
      const next = await options.lock(() => {
        const latest = read();
        const events = replay(latest, batch);
        if (events !== latest) options.getStorage().setItem(ACTIVITY_KEY, serializeActivity(events));
        return events;
      });
      if (ownEpoch !== epoch) return;
      stored = next;
      pending = pending.filter(item => item.sequence > batch[batch.length - 1].sequence);
      publish(replay(stored), currentStatus(), currentMessage());
    } catch (error) {
      if (ownEpoch !== epoch) return;
      if (error instanceof CorruptActivity) blocked = true; else failed = true;
      publish(snapshot.events, currentStatus(), currentMessage());
    } finally {
      writing = false;
      if (refreshNeeded && !resetting) { refreshNeeded = false; refresh(); }
      schedule();
    }
  }
  function enqueue(operation: Operation) {
    start();
    try {
      const safe: Operation = operation.type === 'clear' ? { type: 'clear' } : { type: 'add', event: eventSchema.parse(operation.event) };
      const events = safe.type === 'clear' ? [] : appendActivity(snapshot.events, safe.event);
      if (safe.type !== 'clear' && events === snapshot.events) return;
      pending.push({ sequence: ++sequence, operation: safe });
      publish(events, currentStatus(), currentMessage()); schedule();
    } catch {
      publish(snapshot.events, 'error', '행동 기록의 형식이 올바르지 않아 저장하지 않았습니다.');
    }
  }
  function retry() { start(); if (!blocked) { failed = false; refresh(); } }
  function reset() {
    start();
    if (resetting) return;
    if (!options.lock) { publish(snapshot.events, 'memory-only', memoryMessage); return; }
    resetting = true;
    const cutoff = sequence;
    ++epoch;
    publish(snapshot.events, 'saving', null);
    void options.lock(() => options.getStorage().removeItem(ACTIVITY_KEY)).then(() => {
      stored = [];
      pending = pending.filter(item => item.sequence > cutoff);
      blocked = false; failed = false;
      publish(replay(stored), currentStatus(), currentMessage());
    }).catch(() => {
      failed = true;
      publish(snapshot.events, blocked ? 'corrupt' : 'error', '행동 기록을 초기화하지 못했습니다. 기존 데이터는 유지됩니다.');
    }).finally(() => {
      resetting = false;
      if (refreshNeeded && !writing) { refreshNeeded = false; refresh(); }
      schedule();
    });
  }
  return { getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, refresh, retry, reset, add: (event: ActivityEvent) => enqueue({ type: 'add', event }), clear: () => enqueue({ type: 'clear' }),
    exportJson: (records: HistoryRecord[] = [], includeContent = false) => exportActivityJson(snapshot.events, records, includeContent),
    exportCsv: (records: HistoryRecord[] = [], includeContent = false) => exportActivityCsv(snapshot.events, records, includeContent),
  };
}
export type ActivityController = ReturnType<typeof createActivityController>;
