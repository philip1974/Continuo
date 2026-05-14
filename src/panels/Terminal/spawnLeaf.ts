import { coApi } from '@/lib/co-api';
import type { PanelAction } from './panelReducer';
import type { SpawnReason } from './paneTree';

export interface SpawnRequest {
  tabId: string;
  leafId: string;
  cwd?: string;
  scoped: boolean;
  title?: string;
  reason: SpawnReason;
  cancelled: { current: boolean };
}

export interface SpawnQueue {
  enqueue: (req: SpawnRequest) => void;
  cancelAll: () => void;
  cancelLeaf: (tabId: string, leafId: string) => void;
  cancelTab: (tabId: string) => void;
  pendingKeys: () => string[];
}

export type PanelDispatch = (action: PanelAction) => void;
export type RemoveTerminal = (id: string) => Promise<{ ok: boolean }>;

export function createSpawnQueue(
  dispatch: PanelDispatch,
  removedPtyIds: Set<string>,
): SpawnQueue {
  const pending = new Map<string, SpawnRequest>();

  const queue: SpawnQueue = {
    enqueue: (req) => {
      const key = spawnKey(req.tabId, req.leafId);
      if (pending.has(key)) return;
      pending.set(key, req);
      void run(req);
    },
    cancelAll: () => {
      pending.forEach((req) => {
        req.cancelled.current = true;
      });
      pending.clear();
    },
    cancelLeaf: (tabId, leafId) => {
      const req = pending.get(spawnKey(tabId, leafId));
      if (!req) return;
      req.cancelled.current = true;
      pending.delete(spawnKey(tabId, leafId));
    },
    cancelTab: (tabId) => {
      for (const [key, req] of pending) {
        if (req.tabId !== tabId) continue;
        req.cancelled.current = true;
        pending.delete(key);
      }
    },
    pendingKeys: () => Array.from(pending.keys()),
  };

  async function run(req: SpawnRequest): Promise<void> {
    const key = spawnKey(req.tabId, req.leafId);
    console.debug('[pane-split] spawn-start', req.reason, req.tabId, req.leafId);
    const result = await coApi.terminal.create({
      cwd: req.cwd,
      scoped: req.scoped,
      title: req.title,
    }) as Awaited<ReturnType<typeof coApi.terminal.create>> & {
      data?: { id: string; cwd?: string };
    };
    pending.delete(key);

    if (req.cancelled.current) {
      if (result.ok && result.data?.id) {
        removedPtyIds.add(result.data.id);
        const removeResult = await coApi.terminal.remove(result.data.id);
        if (!removeResult.ok) {
          console.warn(
            '[pane-split] cancelled-spawn remove ok=false',
            result.data.id,
            removeResult,
          );
        }
        console.debug('[pane-split] spawn-cancelled', req.reason, result.data.id);
      }
      return;
    }

    if (!result.ok) {
      console.warn('[pane-split] spawn-failed', req.reason, result.code, result.message);
      dispatch({
        type: 'PANE_ACTION',
        tabId: req.tabId,
        action: { type: 'SET_PTY_FAIL', leafId: req.leafId },
      });
      return;
    }

    dispatch({
      type: 'PANE_ACTION',
      tabId: req.tabId,
      action: {
        type: 'SET_PTY_ID',
        leafId: req.leafId,
        ptyId: result.data.id,
        cwd: result.data.cwd,
      },
    });
  }

  return queue;
}

export function removePtyOnce(
  id: string,
  removedPtyIds: Set<string>,
  remove: RemoveTerminal,
  label: string,
): void {
  if (removedPtyIds.has(id)) return;
  removedPtyIds.add(id);
  remove(id)
    .then((result) => {
      if (!result.ok) {
        console.warn(`[pane-split] ${label} remove ok=false`, id, result);
      }
    })
    .catch((err: unknown) => {
      console.warn(`[pane-split] ${label} remove rejected`, id, err);
    });
}

function spawnKey(tabId: string, leafId: string): string {
  return `${tabId}:${leafId}`;
}
