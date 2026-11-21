import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createHistoryController, HISTORY_KEY, HISTORY_LOCK, type HistoryController, type HistoryLock } from '../lib/history';

export function useHistory() {
  const controllerRef = useRef<HistoryController | null>(null);
  if (!controllerRef.current) {
    const lock: HistoryLock | undefined = typeof navigator !== 'undefined' && navigator.locks
      ? async action => await navigator.locks.request(HISTORY_LOCK, action) : undefined;
    controllerRef.current = createHistoryController({ getStorage: () => window.localStorage, lock });
  }
  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    const onStorage = (event: StorageEvent) => { if (event.key === HISTORY_KEY || event.key === null) controller.refresh(); };
    const onFocus = () => controller.refresh();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
    };
  }, [controller]);
  return { ...snapshot, enqueue: controller.enqueue, remove: controller.remove, clear: controller.clear,
    retry: controller.retry, reset: controller.reset, exportJson: controller.exportJson };
}
