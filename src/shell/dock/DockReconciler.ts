import { useEffect, useRef } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import type { TerminalSession } from '@/stores/terminal.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import {
  consumePanelCloseSuppressed,
  markPanelCloseSuppressed,
} from './wrap-panel-close';
import { panelIdFor, sessionIdFromPanel } from './terminal-panel-id';

export { markPanelCloseSuppressed };

export interface ReconcileInput {
  previousSessions: readonly TerminalSession[];
  nextSessions: readonly TerminalSession[];
  customTitles?: ReadonlyMap<string, string>;
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
// 永久保留(不在 reconciler removed 循环里剪除:那里无法区分「workspace 隐藏」与「真关闭」,
// 剪了会让 workspace 切回再被当首次出现重新抢焦)。
const everAddedSessionIds = new Set<string>();

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
  const prevById = sessionsById(input.previousSessions);
  const nextById = sessionsById(input.nextSessions);

  const added = input.nextSessions
    .filter((s) => !prevById.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt);

  // race(R105):originHint==='user' 时序兜底(见下方 shouldFocus)对**每个**首次出现的 user
  // terminal 都聚焦。两个 terminal.create 并发 + session push 乱序时,较早请求的 session 可能
  // 后到 → 它仍是首次出现 → setActive() 抢焦点,覆盖已先到先聚焦的较新终端,用户键盘输入落到
  // 非预期(较旧)PTY。兜底仅应聚焦当前快照中**最新**的 user session;迟到的较旧 user session
  // 不抢焦点(显式 pendingFocus 路径=用户明确意图,不受此限,始终命中)。
  let latestUserCreatedAt = -Infinity;
  for (const s of input.nextSessions) {
    if (s.originHint === 'user' && s.createdAt > latestUserCreatedAt) {
      latestUserCreatedAt = s.createdAt;
    }
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
    const shouldFocus =
      consumePendingFocus(session.id) ||
      (session.originHint === 'user' &&
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
      title: deriveTitle(session, input.customTitles),
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

  for (const session of input.previousSessions) {
    if (nextById.has(session.id)) continue;
    const panel = api.getPanel(panelIdFor(session.id));
    if (!panel) continue;
    markPanelCloseSuppressed(panel.api.id);
    panel.api.close();
  }

  for (const session of input.nextSessions) {
    if (!prevById.has(session.id)) continue;
    const title = deriveTitle(session, input.customTitles);
    const panel = api.getPanel(panelIdFor(session.id));
    if (!panel) continue;
    if (panel.api.title !== title) {
      panel.api.setTitle(title);
    }
  }
}

export function useDockReconciler(api: DockviewApi | null): void {
  const previousSessionsRef = useRef<readonly TerminalSession[]>([]);
  const currentApiRef = useRef(api);
  currentApiRef.current = api;

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
      customTitles: initial.customTitles,
    });
    previousSessionsRef.current = initial.sessions;
  }, [api]);

  useEffect(() => {
    return useTerminalStore.subscribe((state) => {
      const prev = previousSessionsRef.current;
      const prevTitles = previousCustomTitlesRef.current;
      if (state.sessions === prev && state.customTitles === prevTitles) return;

      const dockApi = currentApiRef.current;
      if (dockApi) {
        reconcileTerminalPanels(dockApi, {
          previousSessions: prev,
          nextSessions: state.sessions,
          customTitles: state.customTitles,
        });
      }
      previousSessionsRef.current = state.sessions;
      previousCustomTitlesRef.current = state.customTitles;
    });
    // 仅 mount 一次订阅,deps 内部用 ref 读最新值。
     
  }, []);
}

const previousCustomTitlesRef: { current: ReadonlyMap<string, string> } = {
  current: new Map(),
};

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

function deriveTitle(
  session: TerminalSession,
  customTitles?: ReadonlyMap<string, string>,
): string {
  const base =
    customTitles?.get(session.id) ??
    session.title ??
    `Terminal ${session.id.slice(0, 6)}`;
  return session.originHint === 'agent' ? `${base} (agent)` : base;
}
