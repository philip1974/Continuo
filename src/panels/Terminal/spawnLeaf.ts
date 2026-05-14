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

// ── 模块级状态 (跨 React StrictMode 双 mount 持久) ───────────────────────
//
// React 19 StrictMode 在 dev 模式 mount → unmount → remount,useRef 也会
// 被 reset,导致 panel-local 的 spawn pending Map 在第二次 mount 时空了。
// 第一次 spawn 在 cleanup 时被 cancelAll 标 cancelled,第二次 mount 又
// enqueue 新 spawn 也被 cleanup cancel → leaf 永远填不到 ptyId。
//
// 把 pending 和 dispatch 都升到 module 级别,key 用 `panelId:tabId:leafId`,
// 这样:
//   - StrictMode 双 mount 下,第二次 enqueue 同 key 自动去重(spawn 不重发)
//   - dispatch SET_PTY_ID 时通过 panelId 查 current dispatch(最新的 mount)
//   - 真 unmount (panel close) 走 wrap-panel-close → cancelPanelSpawns(panelId)
//     清理对应 panel 的所有 pending
//
// 用 panelId 作 key 防多 Terminal panel 串扰。

interface ModulePendingEntry {
  cancelled: { current: boolean };
  reason: SpawnReason;
}

const modulePending = new Map<string, ModulePendingEntry>();
const moduleDispatches = new Map<string, PanelDispatch>();

function moduleKey(panelId: string, tabId: string, leafId: string): string {
  return `${panelId}:${tabId}:${leafId}`;
}

/** 注册或刷新某 panel 的 current dispatch — TerminalPanel mount 时调,不 cleanup. */
export function setPanelDispatch(panelId: string, dispatch: PanelDispatch): void {
  moduleDispatches.set(panelId, dispatch);
}

/** 取消某 panel 的全部 pending spawn — 真 close 时调 (wrap-panel-close). */
export function cancelPanelSpawns(panelId: string): void {
  const prefix = `${panelId}:`;
  for (const [key, entry] of modulePending) {
    if (key.startsWith(prefix)) {
      entry.cancelled.current = true;
      modulePending.delete(key);
    }
  }
  moduleDispatches.delete(panelId);
}

/** 测试用 — 重置模块状态. */
export function _resetModuleSpawnStateForTest(): void {
  modulePending.clear();
  moduleDispatches.clear();
}

// ── createSpawnQueue ─────────────────────────────────────────────────

export function createSpawnQueue(
  dispatch: PanelDispatch,
  removedPtyIds: Set<string>,
  panelId: string,
): SpawnQueue {
  // 同步 dispatch 到 module map (TerminalPanel useEffect 也会显式调,但这里
  // 兜底 — 防 createSpawnQueue 被构造而 useEffect 还没跑的窗口)。
  moduleDispatches.set(panelId, dispatch);

  const queue: SpawnQueue = {
    enqueue: (req) => {
      const key = moduleKey(panelId, req.tabId, req.leafId);
      if (modulePending.has(key)) {
        // 已有 in-flight spawn (常见于 StrictMode 双 mount);跳过,等原 spawn
        // 完成时会用最新 module dispatch 派 SET_PTY_ID 到当前 mount.
        console.debug(
          '[pane-split] spawn-skip-dup',
          req.reason,
          req.tabId,
          req.leafId,
        );
        return;
      }
      modulePending.set(key, { cancelled: req.cancelled, reason: req.reason });
      void run(req, key);
    },
    cancelAll: () => {
      // StrictMode-safe no-op:不在 useEffect cleanup 调这个 (会误 cancel)。
      // 真 close 走 cancelPanelSpawns(panelId)。
    },
    cancelLeaf: (tabId, leafId) => {
      const key = moduleKey(panelId, tabId, leafId);
      const entry = modulePending.get(key);
      if (!entry) return;
      entry.cancelled.current = true;
      modulePending.delete(key);
    },
    cancelTab: (tabId) => {
      const prefix = `${panelId}:${tabId}:`;
      for (const [key, entry] of modulePending) {
        if (!key.startsWith(prefix)) continue;
        entry.cancelled.current = true;
        modulePending.delete(key);
      }
    },
    pendingKeys: () =>
      Array.from(modulePending.keys()).filter((k) => k.startsWith(`${panelId}:`)),
  };

  async function run(req: SpawnRequest, key: string): Promise<void> {
    console.debug('[pane-split] spawn-start', req.reason, req.tabId, req.leafId);
    const result = (await coApi.terminal.create({
      cwd: req.cwd,
      scoped: req.scoped,
      title: req.title,
    })) as Awaited<ReturnType<typeof coApi.terminal.create>> & {
      data?: { id: string; cwd?: string };
    };
    modulePending.delete(key);

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

    // 用当前 module dispatch (最新 mount 的) 派 SET_PTY_ID / SET_PTY_FAIL
    const liveDispatch = moduleDispatches.get(panelId);
    if (!liveDispatch) {
      // panel 已彻底关 (cancelPanelSpawns 清了 dispatch);spawn 是孤儿
      if (result.ok && result.data?.id) {
        removedPtyIds.add(result.data.id);
        void coApi.terminal.remove(result.data.id);
        console.debug(
          '[pane-split] spawn-orphan-no-dispatch',
          req.reason,
          result.data.id,
        );
      }
      return;
    }

    if (!result.ok) {
      console.warn('[pane-split] spawn-failed', req.reason, result.code, result.message);
      liveDispatch({
        type: 'PANE_ACTION',
        tabId: req.tabId,
        action: { type: 'SET_PTY_FAIL', leafId: req.leafId },
      });
      return;
    }

    liveDispatch({
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
