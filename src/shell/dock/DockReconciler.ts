import { useEffect, useRef } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import type { TerminalSession } from '@/stores/terminal.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import {
  consumePanelCloseSuppressed,
  markPanelCloseSuppressed,
} from './wrap-panel-close';
import {
  panelIdFor,
  sessionIdFromPanel,
  terminalPanelTitle,
} from './terminal-panel-id';

export { markPanelCloseSuppressed };

export interface ReconcileInput {
  previousSessions: readonly TerminalSession[];
  nextSessions: readonly TerminalSession[];
  /**
   * 新 dock api 首次全量重建(布局恢复后挂载 / api 重建):added 都是存量 session,不是「刚创建」。
   * 不走 originHint==='user' 兜底聚焦(否则 setActive 抢走 fromJSON 恢复的活动面板),仅显式
   * pendingFocus(用户明确意图)仍聚焦;它们照常登记进 everAddedSessionIds。
   */
  hydrate?: boolean;
  /**
   * 仅配合 hydrate:恢复开始时刻(ms,与 session.createdAt 同为墙钟)。给出时 hydrate 只抑制
   * createdAt 早于它的存量 session;恢复期间新建的(如布局恢复中按 Cmd+T,其 setPendingFocus 晚于
   * 首次 reconcile 才执行、无人消费)照常走 originHint 兜底聚焦。缺省 = 抑制全部 added。
   */
  hydrateBefore?: number;
}

// pendingFocus 由 user 路径(Cmd+T / + 按钮)在 coApi.terminal.create resolve 后
// 设置;reconciler 见到对应 session 加入 store 即 setActive 一次。5s 超时自清
// 防 create 失败 / 久未触发的残留污染下个不相关的 session。
let pendingFocusSessionId: string | null = null;
let pendingFocusTimer: ReturnType<typeof setTimeout> | null = null;
const PENDING_FOCUS_TTL_MS = 5000;

// race(R25):本 app session 内「曾经出现过」的 session id。originHint==='user' 的时序兜底
// (见下方 shouldFocus 注释)只应对**首次出现**的 user terminal 生效;否则 workspace 切换时
// 旧 workspace 的 user terminal(workspaceRoot 过滤后隐藏、切回再现 = 重新进 added)会被误判
// 为新建而 setActive 抢焦点,用户可能在错误面板继续键盘输入。重现的 session 已在此 set 中 →
// 不走兜底。真正新建的 session 不在 set 中 → 保留兜底聚焦(对照 startup 注释的设计意图)。
// 不在 reconciler removed 循环里剪除:那里只看到 workspace 过滤后的可见列表,无法区分「workspace
// 隐藏」与「真关闭」,剪了会让 workspace 切回再被当首次出现重新抢焦。
// 性能(内存):只增不删会随进程生命周期内创建过的终端总数无界增长 → 由 TerminalSessionsSync 在
// 收到权威的本窗口 sessions 快照(owner 过滤后、workspace 过滤前)时调 pruneReconcilerSeenSessions
// 剪掉已不存在的 id(workspace 隐藏的 session 仍在该快照里,不受影响)。
const everAddedSessionIds = new Set<string>();

/**
 * 剪除 everAddedSessionIds 中已不在 `liveOwnedSessions` 的 id。`liveOwnedSessions` 必须是**未按
 * workspace 过滤**的本窗口 sessions 快照(TerminalSessionsSync 的 rawOwned)—— 传可见列表会把
 * workspace 隐藏的 session 剪掉,切回时被误判首次出现而抢焦(R25)。
 */
export function pruneReconcilerSeenSessions(
  liveOwnedSessions: readonly TerminalSession[],
): void {
  if (everAddedSessionIds.size === 0) return;
  const live = new Set<string>();
  for (const s of liveOwnedSessions) live.add(s.id);
  for (const id of everAddedSessionIds) {
    if (!live.has(id)) everAddedSessionIds.delete(id);
  }
}

/** 仅测试用:当前 first-appearance 记录条数(验证有界)。 */
export function __reconcilerSeenSessionCountForTest(): number {
  return everAddedSessionIds.size;
}

/** 仅测试用:重置模块级 first-appearance 记录。 */
export function __resetReconcilerForTest(): void {
  everAddedSessionIds.clear();
  pendingFocusSessionId = null;
  if (pendingFocusTimer) {
    clearTimeout(pendingFocusTimer);
    pendingFocusTimer = null;
  }
}

export function setPendingFocus(sessionId: string): void {
  pendingFocusSessionId = sessionId;
  if (pendingFocusTimer) clearTimeout(pendingFocusTimer);
  pendingFocusTimer = setTimeout(() => {
    pendingFocusSessionId = null;
    pendingFocusTimer = null;
  }, PENDING_FOCUS_TTL_MS);
}

function consumePendingFocus(sessionId: string): boolean {
  if (pendingFocusSessionId !== sessionId) return false;
  pendingFocusSessionId = null;
  if (pendingFocusTimer) {
    clearTimeout(pendingFocusTimer);
    pendingFocusTimer = null;
  }
  return true;
}

function sessionsById(
  sessions: readonly TerminalSession[],
): Map<string, TerminalSession> {
  const byId = new Map<string, TerminalSession>();
  for (const session of sessions) byId.set(session.id, session);
  return byId;
}

export function reconcileTerminalPanels(
  api: DockviewApi,
  input: ReconcileInput,
): void {
  if (input.previousSessions === input.nextSessions) return;

  const prevById = sessionsById(input.previousSessions);
  const nextById = sessionsById(input.nextSessions);

  // race(R105):originHint==='user' 时序兜底(见下方 shouldFocus)对**每个**首次出现的 user
  // terminal 都聚焦。两个 terminal.create 并发 + session push 乱序时,较早请求的 session 可能
  // 后到 → 它仍是首次出现 → setActive() 抢焦点,覆盖已先到先聚焦的较新终端,用户键盘输入落到
  // 非预期(较旧)PTY。兜底仅应聚焦当前快照中**最新**的 user session;迟到的较旧 user session
  // 不抢焦点(显式 pendingFocus 路径=用户明确意图,不受此限,始终命中)。
  let added: TerminalSession[] | undefined;
  let addedCount = 0;
  let addedSorted = true;
  let prevAddedCreatedAt = -Infinity;
  let latestUserCreatedAt = -Infinity;
  for (const s of input.nextSessions) {
    if (!prevById.has(s.id)) {
      added ??= new Array<TerminalSession>(input.nextSessions.length);
      if (s.createdAt < prevAddedCreatedAt) addedSorted = false;
      prevAddedCreatedAt = s.createdAt;
      added[addedCount] = s;
      addedCount += 1;
    }
    if (s.originHint === 'user' && s.createdAt > latestUserCreatedAt) {
      latestUserCreatedAt = s.createdAt;
    }
  }

  if (added !== undefined) {
    added.length = addedCount;
    if (added.length > 1 && !addedSorted) {
      added.sort((a, b) => a.createdAt - b.createdAt);
    }

    let lastRefId = findLastTerminalPanelId(api);
    for (const session of added) {
      const panelId = panelIdFor(session.id);
      if (api.getPanel(panelId)) {
        lastRefId = panelId;
        continue;
      }

      const position = lastRefId
        ? { referencePanel: lastRefId, direction: 'right' as const }
        : undefined;
      // user 路径走 coApi.terminal.create → main 同时 RPC reply + IPC push
      // sessions-changed。renderer 的 IPC handler 可能比 RPC await resolve 先跑,
      // 此时 user 路径的 setPendingFocus 还没执行 → pendingFocus 命不中。
      // 用 originHint === 'user' 做时序无关兜底:user 主动创建的 session 应该 focus
      // (对照 agent 创建的不抢 focus)。
      // race(R25):但兜底**仅限首次出现**的 user terminal。workspace 切换时旧 workspace 的
      // user terminal 经 workspaceRoot 过滤隐藏、切回再现 = 重新进 added,若仍走 originHint 兜底
      // 会被误判新建而抢焦点。everAddedSessionIds 记录曾出现过的 id:重现的 session 已在其中 →
      // 不兜底(除非显式 pendingFocus);真新建不在其中 → 保留兜底聚焦。
      const isFirstAppearance = !everAddedSessionIds.has(session.id);
      everAddedSessionIds.add(session.id);
      // race(R105):兜底加「是快照中最新 user session」约束,迟到的较旧 user session 不抢焦点。
      const isLatestUserSession =
        session.originHint === 'user' &&
        session.createdAt === latestUserCreatedAt;
      const isHydrated =
        input.hydrate === true &&
        (input.hydrateBefore === undefined || session.createdAt < input.hydrateBefore);
      const shouldFocus =
        consumePendingFocus(session.id) ||
        (!isHydrated &&
          session.originHint === 'user' &&
          isFirstAppearance &&
          isLatestUserSession);
      // dockview addPanel 的 `inactive: true` 让新 group 容器在 xterm 渲染
      // 不可见的状态(数据进 xterm 内部但屏幕全黑)。改用"默认 active 加 →
      // 立即 setActive 回原 panel"实现 agent 不抢 focus 的等价 UX。
      const previousActivePanelId = !shouldFocus
        ? api.activePanel?.api.id ?? null
        : null;
      api.addPanel({
        id: panelId,
        component: TERMINAL_PANEL_TYPE,
        title: deriveTitle(session),
        params: {
          sessionId: session.id,
          originHint: session.originHint,
          cwd: session.cwd,
        },
        ...(position ? { position } : {}),
      });
      lastRefId = panelId;

      if (shouldFocus) {
        api.getPanel(panelId)?.api.setActive();
      } else if (previousActivePanelId && previousActivePanelId !== panelId) {
        api.getPanel(previousActivePanelId)?.api.setActive();
      }
    }
  }

  for (const session of input.previousSessions) {
    if (nextById.has(session.id)) continue;
    const panel = api.getPanel(panelIdFor(session.id));
    if (!panel) continue;
    markPanelCloseSuppressed(panel.api.id);
    panel.api.close();
  }

  for (const session of input.nextSessions) {
    if (!prevById.has(session.id)) continue;
    const title = deriveTitle(session);
    const panel = api.getPanel(panelIdFor(session.id));
    if (!panel) continue;
    if (panel.api.title !== title) {
      panel.api.setTitle(title);
    }
  }
}

/**
 * @param hydrateBefore 本 api 布局恢复开始时刻(见 ReconcileInput.hydrateBefore);缺省 = 首次 reconcile
 *   的存量 session 全部按 hydrate 处理。
 * @param onHydrated 本 api 已按终端首个权威快照(store.hydrated)完成 reconcile 时调用(每个 api 一次)。
 *   DockShell 据此解除 Splash 就绪屏障。
 */
export function useDockReconciler(
  api: DockviewApi | null,
  hydrateBefore?: number,
  onHydrated?: () => void,
): void {
  const previousSessionsRef = useRef<readonly TerminalSession[]>([]);
  const currentApiRef = useRef(api);
  currentApiRef.current = api;
  const hydrateBeforeRef = useRef(hydrateBefore);
  hydrateBeforeRef.current = hydrateBefore;
  const onHydratedRef = useRef(onHydrated);
  onHydratedRef.current = onHydrated;
  // 挂载时 store 尚未收到首个快照 → 首个快照到达那轮 reconcile 仍按 hydrate 处理:其中都是存量 session
  // (如 renderer reload 时 listSessions 晚于 layout.read 返回),不得 setActive 抢走恢复出的活动面板。
  const awaitingHydrateRef = useRef(false);

  useEffect(() => {
    if (!api) return;
    const initial = useTerminalStore.getState();
    // race(R26):api 变更(dockview 重建 / onReady 重入 / HMR / StrictMode)= 一个全新的空 dock。
    // 持久布局经 sanitizePersistedDockLayout 永不含 terminal panel(终端 panel 被剥离),终端只由本
    // reconciler 从 store 建。若此处用 previousSessionsRef.current(上个 api 的旧 sessions)做 diff,
    // 现有 session 会被判「非新增」→ 不在新空 dock 补建 → 终端消失直到 sessions 再变化。新 api 一律
    // 视作空:previousSessions=[],让现有 sessions 全量重建(reconciler 内 getPanel 守卫防重复)。
    // 首次挂载 ref 本就是 [],行为不变。
    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: initial.sessions,
      hydrate: true,
      ...(hydrateBefore !== undefined ? { hydrateBefore } : {}),
    });
    previousSessionsRef.current = initial.sessions;
    awaitingHydrateRef.current = !initial.hydrated;
    if (initial.hydrated) onHydratedRef.current?.();
    // hydrateBefore 与 api 由 DockShell 在同一次 setState 中设定,随 api 一起变化。
  }, [api, hydrateBefore]);

  useEffect(() => {
    return useTerminalStore.subscribe((state) => {
      const prev = previousSessionsRef.current;
      const hydrateNow = awaitingHydrateRef.current && state.hydrated;
      if (state.sessions === prev && !hydrateNow) return;
      if (hydrateNow) awaitingHydrateRef.current = false;

      const dockApi = currentApiRef.current;
      if (dockApi) {
        const before = hydrateBeforeRef.current;
        reconcileTerminalPanels(dockApi, {
          previousSessions: prev,
          nextSessions: state.sessions,
          ...(hydrateNow
            ? { hydrate: true, ...(before !== undefined ? { hydrateBefore: before } : {}) }
            : {}),
        });
      }
      previousSessionsRef.current = state.sessions;
      if (hydrateNow && dockApi) onHydratedRef.current?.();
    });
    // 仅 mount 一次订阅,deps 内部用 ref 读最新值。
     
  }, []);
}

export interface HandleTerminalPanelRemovedInput {
  panel: Pick<IDockviewPanel, 'params'> & {
    api: Pick<IDockviewPanel['api'], 'id'>;
  };
  api: Pick<DockviewApi, 'getPanel'>;
  removeSession: (sessionId: string) => void | Promise<void>;
}

export async function handleTerminalPanelRemoved({
  panel,
  api,
  removeSession,
}: HandleTerminalPanelRemovedInput): Promise<void> {
  const panelId = panel.api.id;
  if (consumePanelCloseSuppressed(panelId)) return;

  await Promise.resolve();
  if (api.getPanel(panelId)) return;

  const sessionId = sessionIdFromPanel(panel);
  if (!sessionId) return;
  await removeSession(sessionId);
}

function findLastTerminalPanelId(api: DockviewApi): string | null {
  // 真实 dockview 给 IDockviewPanel[];test 用 Record<id, panel> mock,做兼容。
  if (Array.isArray(api.panels)) {
    for (let i = api.panels.length - 1; i >= 0; i--) {
      const panel = api.panels[i];
      if (!panel) continue;
      if (sessionIdFromPanel(panel)) return panel.api.id;
    }
    return null;
  }

  let lastId: string | null = null;
  const panels = api.panels as unknown as Record<string, IDockviewPanel>;
  for (const id in panels) {
    if (!Object.prototype.hasOwnProperty.call(panels, id)) continue;
    const panel = panels[id];
    if (panel && sessionIdFromPanel(panel)) lastId = panel.api.id;
  }
  return lastId;
}

function deriveTitle(session: TerminalSession): string {
  return terminalPanelTitle({
    sessionId: session.id,
    sessionTitle: session.title,
    originHint: session.originHint,
  });
}
