import { useEffect, useMemo } from 'react';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { t as translate } from '@/i18n';
import {
  filterByOwnerWindow,
  filterByWorkspaceRoot,
  useTerminalStore,
  type FilterDropOpts,
  type TerminalSession,
} from '@/stores/terminal.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { pruneReconcilerSeenSessions } from './DockReconciler';

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
      // 不会再有快照到达 → 解除 Splash 就绪屏障(不让它干等安全上限)。
      useTerminalStore.getState().markHydrated();
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
    // null = 尚无权威快照(listSessions 在途 / 失败且无广播):此时不得把「无快照」当空快照置 hydrated。
    let rawOwned: readonly TerminalSession[] | null = null;

    // 按 owner 过滤 IPC 快照。droppedIds:本轮因 wrong-owner 以外的原因被丢弃(shape-invalid /
    // missing-owner)且能解析出字符串 id 的项 —— 可能正是本窗口仍存活的 session,过滤结果里缺失不能当作
    // 真删除。wrong-owner 是他窗口 session,确定不属于本窗口,不算。无法解析 id 的丢弃项(not-object /
    // id 非字符串 / over-capacity)无从对应 seen 记录里的任何 id,不参与保护。
    const filterOwned = (
      sessions: readonly unknown[],
    ): { owned: readonly TerminalSession[]; droppedIds: string[] } => {
      const droppedIds: string[] = [];
      const owned = filterByOwnerWindow(sessions, winId, {
        onDrop: (sessionId, reason) => {
          if (reason !== 'wrong-owner' && sessionId !== undefined) droppedIds.push(sessionId);
          warnOnDrop(sessionId, reason);
        },
      });
      return { owned, droppedIds };
    };

    // rawOwned 每次被权威快照替换后调用:剪掉 reconciler 首次出现记录里已真正消失的 session
    // (基于 workspace 过滤前的 rawOwned,workspace 隐藏的仍保留,见 pruneReconcilerSeenSessions)。
    // 被歧义丢弃的 id 保留:否则该 session 下次以有效形态重现会被当首次出现而 setActive 抢焦;其余照常剪,
    // 持续混入畸形项也不会让记录重新无界增长。
    const setRawOwned = ({
      owned,
      droppedIds,
    }: ReturnType<typeof filterOwned>): void => {
      rawOwned = owned;
      pruneReconcilerSeenSessions(owned, droppedIds);
    };

    const applyWorkspaceFilter = (): void => {
      if (rawOwned === null) return;
      const workspace = useWorkspaceStore.getState();
      // workspace 尚未完成持久化恢复时 root 仍是初始 null:此时过滤会把存量 workspace 终端滤掉、恢复后
      // 再当普通新增(兜底聚焦抢焦)。首轮可见过滤等 workspace hydrated(由下方订阅触发)。
      if (!workspace.hydrated) return;
      const store = useTerminalStore.getState();
      store.replaceSnapshot(filterByWorkspaceRoot(rawOwned, workspace.root));
      // 空快照时 replaceSnapshot 不产生变化 → 显式标记已收到首个权威快照(非空时已原子置位,此处 no-op)。
      store.markHydrated();
    };

    coApi.terminal
      .listSessions()
      .then((r) => {
        if (cancelled || sawPush) return; // 被实时推送取代 → 不算失败
        if (!r.ok || !Array.isArray(r.data?.sessions)) {
          // a11y(A130,A129 同族):初始会话恢复失败此前静默早返(列表缺失无反馈)→ notify。
          notify.error(translate('errors.terminal.sessions_restore_failed'));
          // 初始拉取已失败:只放行 Splash 屏障;之后首个有效广播仍按 hydrate 处理(不置 hydrated)。
          useTerminalStore.getState().markSettled();
          return;
        }
        setRawOwned(filterOwned(r.data.sessions));
        applyWorkspaceFilter();
      })
      .catch(() => {
        // a11y(A130):IPC reject 此前是未处理 rejection + 静默失败 → notify(被推送取代则跳过)。
        if (cancelled || sawPush) return;
        notify.error(translate('errors.terminal.sessions_restore_failed'));
        useTerminalStore.getState().markSettled();
      });

    const unsub = coApi.terminal.onSessionsChanged((snapshot) => {
      // 边界(E174,E168-E173 同族 IPC ingress 纵深防御):实时广播 snapshot 须先校验是数组 —— 初始
      // listSessions 路径已有 Array.isArray 守卫(line 68),广播路径此前缺,畸形 payload(null/对象/
      // 字符串)在 filterByOwnerWindow 的 `for (const s of sessions)` 处抛 → 中断会话同步、列表停旧态。
      // 非法 → warn + notify(同初始路径 UX),且**不置 sawPush**(畸形广播不应抑制有效的初始 hydration)。
      if (!Array.isArray(snapshot)) {
        console.warn(
          '[terminal-sync] invalid sessions_changed payload, dropped',
          snapshot,
        );
        notify.error(translate('errors.terminal.sessions_restore_failed'));
        return;
      }
      sawPush = true;
      setRawOwned(filterOwned(snapshot));
      applyWorkspaceFilter();
    });

    // 当前 workspace 切换 / 首次恢复完成 → 用最新 raw 重新过滤(契约:visible = global || workspaceRoot===root)。
    const unsubWorkspace = useWorkspaceStore.subscribe((s, prev) => {
      if (s.root !== prev.root || s.hydrated !== prev.hydrated) applyWorkspaceFilter();
    });

    return () => {
      cancelled = true;
      unsub?.();
      unsubWorkspace();
    };
  }, [winId]);

  return null;
}
