import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { t as translate } from '@/i18n';

type SpawnReason = 'hydrate' | 'split' | 'addTab' | 'retry';
type SpawnLeafDispatchAction = {
  type: 'PANE_ACTION';
  tabId: string;
  action:
    | { type: 'SET_PTY_FAIL'; leafId: string }
    | {
        type: 'SET_PTY_ID';
        leafId: string;
        ptyId: string;
        cwd?: string | undefined;
      };
};

export interface SpawnRequest {
  tabId: string;
  leafId: string;
  cwd?: string;
  scoped: boolean;
  title?: string;
  reason: SpawnReason;
  cancelled: { current: boolean };
  /** 当前 workspace.root,透传给 main 端 sessions metadata 用于跨 workspace 过滤。 */
  workspaceRoot?: string;
}

export interface SpawnQueue {
  enqueue: (req: SpawnRequest) => void;
  cancelAll: () => void;
  cancelLeaf: (tabId: string, leafId: string) => void;
  cancelTab: (tabId: string) => void;
  pendingKeys: () => string[];
}

export type PanelDispatch = (action: SpawnLeafDispatchAction) => void;
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

// ── createSpawnQueue ─────────────────────────────────────────────────

export function createSpawnQueue(
  dispatch: PanelDispatch,
  removedPtyIds: Set<string>,
  panelId: string,
): SpawnQueue {
  // module-level dispatch map:cancelPanelSpawns 用同 key 清 pending。
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

  // race(R43):取消 / 无 dispatch 的迟到 spawn 成功结果须清掉 main 侧已建的孤儿 PTY。统一 await +
  // try/catch + 检查 ok:false:remove IPC reject 此前在「取消」分支(await 无 try/catch)会让 run()
  // 产生未处理 rejection,在「orphan」分支(void remove 不检查)会静默漏掉清理失败 → 不可见孤儿
  // PTY/session(后续仍占资源或被会话同步带回)。本 helper 不抛(失败仅记录),两分支共用。
  async function removeOrphanPty(id: string, reason: string): Promise<void> {
    removedPtyIds.add(id);
    try {
      const r = await coApi.terminal.remove(id);
      if (!r.ok) {
        console.warn(`[pane-split] ${reason} remove ok=false`, id, r);
      }
    } catch (err) {
      console.warn(`[pane-split] ${reason} remove rejected`, id, err);
    }
  }

  async function run(req: SpawnRequest, key: string): Promise<void> {
    console.debug('[pane-split] spawn-start', req.reason, req.tabId, req.leafId);
    let result: Awaited<ReturnType<typeof coApi.terminal.create>> & {
      data?: { id: string; cwd?: string };
    };
    try {
      result = (await coApi.terminal.create({
        cwd: req.cwd,
        scoped: req.scoped,
        title: req.title,
        ...(req.workspaceRoot !== undefined ? { workspaceRoot: req.workspaceRoot } : {}),
      })) as Awaited<ReturnType<typeof coApi.terminal.create>> & {
        data?: { id: string; cwd?: string };
      };
    } catch (err) {
      // a11y(A128 同族):create IPC reject 此前由外层 void run() 丢弃 → modulePending 不清、
      // 不派 SET_PTY_FAIL,终端 leaf 永久停在 loading。这里清账 + 派 fail(若仍有 live dispatch)
      // + notify.error,让 leaf 退出 loading 并给用户/SR 反馈。
      modulePending.delete(key);
      console.warn('[pane-split] spawn-rejected', req.reason, err);
      if (req.cancelled.current) return;
      const code = (err as { code?: string })?.code ?? 'EXCEPTION';
      moduleDispatches.get(panelId)?.({
        type: 'PANE_ACTION',
        tabId: req.tabId,
        action: { type: 'SET_PTY_FAIL', leafId: req.leafId },
      });
      notify.error(translate('errors.terminal.create_failed', { code }), { code });
      return;
    }
    modulePending.delete(key);

    if (req.cancelled.current) {
      if (result.ok && result.data?.id) {
        // race(R43):await + 内部 catch,不让 remove reject 冒泡成 run() 的未处理 rejection。
        await removeOrphanPty(result.data.id, 'cancelled-spawn');
        console.debug('[pane-split] spawn-cancelled', req.reason, result.data.id);
      }
      return;
    }

    // 用当前 module dispatch (最新 mount 的) 派 SET_PTY_ID / SET_PTY_FAIL
    const liveDispatch = moduleDispatches.get(panelId);
    if (!liveDispatch) {
      // panel 已彻底关 (cancelPanelSpawns 清了 dispatch);spawn 是孤儿
      if (result.ok && result.data?.id) {
        // race(R43):await + 内部 catch,清理失败可见(此前 void remove 不检查 → 静默漏孤儿)。
        await removeOrphanPty(result.data.id, 'spawn-orphan-no-dispatch');
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

