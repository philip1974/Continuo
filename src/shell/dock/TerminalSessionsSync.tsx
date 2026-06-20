import { useEffect, useMemo } from 'react';
import { coApi } from '@/lib/co-api';
import {
  filterByOwnerWindow,
  filterByWorkspaceRoot,
  useTerminalStore,
  type FilterDropOpts,
  type TerminalSession,
} from '@/stores/terminal.store';
import { useWorkspaceStore } from '@/stores/workspace.store';

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

export function TerminalSessionsSync(): null {
  const winId = useMemo(() => coApi.system.windowId, []);

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
    // listSessions() 是一次性初始 hydration;onSessionsChanged 是实时推送。
    // 两条路径独立(请求/响应 vs 广播),可乱序到达。若推送先到、初始 listSessions
    // 后 resolve,旧实现会用陈旧快照覆盖更新的状态 → 刚创建的会话从 tab 栏短暂消失。
    // 一旦收到任何实时推送,订阅即为权威,丢弃迟到的初始结果(mirror update/reviews store gen 守卫)。
    let sawPush = false;
    // 最近一次 owner-过滤后的 raw 快照。workspace root 变化时据此重新过滤,使切换 workspace
    // 后旧项目 terminal 隐藏、切回旧根又重现(PTY 在 main 仍活,这里只是视图过滤)。(R12)
    let rawOwned: readonly TerminalSession[] = [];

    const applyWorkspaceFilter = (): void => {
      const root = useWorkspaceStore.getState().root;
      useTerminalStore
        .getState()
        .replaceSnapshot(filterByWorkspaceRoot(rawOwned, root));
    };

    void coApi.terminal.listSessions().then((r) => {
      if (cancelled || sawPush || !r.ok || !Array.isArray(r.data?.sessions))
        return;
      rawOwned = filterByOwnerWindow(r.data.sessions, winId, { onDrop: warnOnDrop });
      applyWorkspaceFilter();
    });

    const unsub = coApi.terminal.onSessionsChanged((snapshot) => {
      sawPush = true;
      rawOwned = filterByOwnerWindow(snapshot, winId, { onDrop: warnOnDrop });
      applyWorkspaceFilter();
    });

    // 当前 workspace 切换 → 用最新 raw 重新过滤(契约:visible = global || workspaceRoot===root)。
    const unsubWorkspace = useWorkspaceStore.subscribe((s, prev) => {
      if (s.root !== prev.root) applyWorkspaceFilter();
    });

    return () => {
      cancelled = true;
      unsub?.();
      unsubWorkspace();
    };
  }, [winId]);

  return null;
}
