import { useEffect, useRef } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import type { TerminalSession } from '@/stores/terminal.store';
import { useTerminalStore } from '@/stores/terminal.store';
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

export function reconcileTerminalPanels(
  api: DockviewApi,
  input: ReconcileInput,
): void {
  const prevById = new Map(input.previousSessions.map((s) => [s.id, s]));
  const nextById = new Map(input.nextSessions.map((s) => [s.id, s]));

  const added = input.nextSessions
    .filter((s) => !prevById.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt);

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
    const shouldFocus = consumePendingFocus(session.id);
    // dockview addPanel 的 `inactive: true` 让新 group 容器在 xterm 渲染
    // 不可见的状态(数据进 xterm 内部但屏幕全黑)。改用"默认 active 加 →
    // 立即 setActive 回原 panel"实现 agent 不抢 focus 的等价 UX。
    const previousActivePanelId = !shouldFocus
      ? api.activePanel?.api.id ?? null
      : null;
    api.addPanel({
      id: panelId,
      component: 'terminal',
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
    reconcileTerminalPanels(api, {
      previousSessions: previousSessionsRef.current,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const panels = Array.isArray(api.panels)
    ? api.panels
    : Object.values(api.panels as unknown as Record<string, IDockviewPanel>);
  for (let i = panels.length - 1; i >= 0; i--) {
    const panel = panels[i];
    if (!panel) continue;
    if (sessionIdFromPanel(panel)) return panel.api.id;
  }
  return null;
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
