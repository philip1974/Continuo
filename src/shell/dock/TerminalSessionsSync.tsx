import { useEffect } from 'react';
import { coApi } from '@/lib/co-api';
import { useTerminalStore, type TerminalSession } from '@/stores/terminal.store';

export function TerminalSessionsSync(): null {
  useEffect(() => {
    let cancelled = false;

    void coApi.terminal.listSessions().then((r) => {
      if (cancelled || !r.ok || !Array.isArray(r.data?.sessions)) return;
      useTerminalStore
        .getState()
        .replaceSnapshot(r.data.sessions as readonly TerminalSession[]);
    });

    const unsub = coApi.terminal.onSessionsChanged((snapshot) => {
      useTerminalStore
        .getState()
        .replaceSnapshot(snapshot as readonly TerminalSession[]);
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  return null;
}
