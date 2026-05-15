import { useEffect, useMemo } from 'react';
import { coApi } from '@/lib/co-api';
import {
  filterByOwnerWindow,
  useTerminalStore,
  type FilterDropOpts,
} from '@/stores/terminal.store';

const warnedDropKeys = new Set<string>();
let warnedNonFiniteOnce = false;

export function _resetTerminalDropWarningsForTest(): void {
  warnedDropKeys.clear();
  warnedNonFiniteOnce = false;
}

const warnOnDrop: NonNullable<FilterDropOpts['onDrop']> = (
  sessionId,
  reason,
) => {
  const key = `${sessionId ?? '<unknown>'}|${reason}`;
  if (warnedDropKeys.has(key)) return;
  warnedDropKeys.add(key);
  console.warn(`[terminal-store] dropping session: ${reason}`, sessionId);
};

function readWindowIdForIngress(): number | undefined {
  const api = coApi as typeof coApi & {
    system?: { readonly windowId?: number };
  };
  if (!('system' in api)) {
    return 1;
  }
  return api.system?.windowId;
}

export function TerminalSessionsSync(): null {
  const winId = useMemo(() => readWindowIdForIngress(), []);

  useEffect(() => {
    if (typeof winId !== 'number' || !Number.isFinite(winId)) {
      if (!warnedNonFiniteOnce) {
        warnedNonFiniteOnce = true;
        console.warn(
          '[terminal-store] coApi.system.windowId is not finite, skipping ingress filter',
          winId,
        );
      }
      return;
    }

    let cancelled = false;

    void coApi.terminal.listSessions().then((r) => {
      if (cancelled || !r.ok || !Array.isArray(r.data?.sessions)) return;
      useTerminalStore.getState().replaceSnapshot(
        filterByOwnerWindow(r.data.sessions, winId, { onDrop: warnOnDrop }),
      );
    });

    const unsub = coApi.terminal.onSessionsChanged((snapshot) => {
      useTerminalStore.getState().replaceSnapshot(
        filterByOwnerWindow(snapshot, winId, { onDrop: warnOnDrop }),
      );
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [winId]);

  return null;
}
