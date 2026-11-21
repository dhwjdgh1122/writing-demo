import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ACTIVITY_KEY, ACTIVITY_LOCK, createActivityController, loadActivityParticipant, saveActivityParticipant, participantCodeSchema,
  type ActivityController, type ActivityInput } from '../lib/activity';
import type { HistoryLock } from '../lib/history';

export function useActivity() {
  const controllerRef = useRef<ActivityController | null>(null);
  const identityRef = useRef<{ sessionId: string; participantCode: string; storageError: string | null } | null>(null);
  if (!identityRef.current) {
    const saved = loadActivityParticipant(() => window.localStorage, `T-${crypto.randomUUID().slice(0, 8)}`);
    identityRef.current = { sessionId: crypto.randomUUID(), participantCode: saved.code, storageError: saved.error };
  }
  if (!controllerRef.current) {
    const lock: HistoryLock | undefined = typeof navigator !== 'undefined' && navigator.locks
      ? async action => await navigator.locks.request(ACTIVITY_LOCK, action) : undefined;
    controllerRef.current = createActivityController({ getStorage: () => window.localStorage, lock });
  }
  const controller = controllerRef.current;
  const [participantCode, updateParticipantCode] = useState(identityRef.current.participantCode);
  const [participantStorageError, setParticipantStorageError] = useState(identityRef.current.storageError);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    const onStorage = (event: StorageEvent) => { if (event.key === ACTIVITY_KEY || event.key === null) controller.refresh(); };
    const onFocus = () => controller.refresh();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('focus', onFocus); };
  }, [controller]);
  const record = useCallback((input: ActivityInput) => {
    const identity = identityRef.current!;
    controller.add({ ...input, sessionId: identity.sessionId, participantCode: identity.participantCode,
      id: crypto.randomUUID(), at: new Date().toISOString() });
  }, [controller]);
  const setParticipantCode = useCallback((input: string) => {
    const parsed = participantCodeSchema.safeParse(input.trim());
    if (!parsed.success) return false;
    identityRef.current!.participantCode = parsed.data;
    updateParticipantCode(parsed.data);
    setParticipantStorageError(saveActivityParticipant(() => window.localStorage, parsed.data));
    return true;
  }, []);
  return { ...snapshot, participantCode, participantStorageError, setParticipantCode, record, clear: controller.clear, retry: controller.retry,
    reset: controller.reset, exportJson: controller.exportJson, exportCsv: controller.exportCsv };
}
export type ActivityApi = ReturnType<typeof useActivity>;
