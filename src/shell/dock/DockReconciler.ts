import { useEffect, useRef } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import type { TerminalSession } from '@/stores/terminal.store';
import { useTerminalStore } from '@/stores/terminal.store';
import {
  consumePanelCloseSuppressed,
  markPanelCloseSuppressed,
} from './wrap-panel-close';

export { markPanelCloseSuppressed };

export interface ReconcileInput {
  previousSessions: readonly TerminalSession[];
  nextSessions: readonly TerminalSession[];
  customTitles?: ReadonlyMap<string, string>;
  pendingFocusSessionIdRef?: { current: string | null };
}

interface TerminalPanelParams {
  sessionId?: string;
  originHint?: 'user' | 'agent';
  cwd?: string;
}

let pendingFocusSessionId: string | null = null;

export function setPendingFocus(sessionId: string): void {
  pendingFocusSessionId = sessionId;
}

export function reconcileTerminalPanels(
  api: DockviewApi,
  input: ReconcileInput,
): void {
  const prevById = new Map(input.previousSessions.map((s) => [s.id, s]));
  const nextById = new Map(input.nextSessions.map((s) => [s.id, s]));

  const added = input.nextSessions
    .filter((s) => !prevById.has(s.id))
    .slice()
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
    const shouldFocus = consumePendingFocus(session.id, input.pendingFocusSessionIdRef);
    // 不能用 dockview addPanel 的 `inactive: true` —— 它把新 group 容器置于
    // 一种 xterm 渲染不可见的状态(实测:dataLength>0 进 xterm 但屏幕全黑,
    // 用户必须点击 panel 才显示)。改用"先 addPanel(默认 active) → 立即
    // setActive 回原 panel"实现 agent 不抢 focus 的等价 UX。
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
      // agent 路径:恢复原 active panel,避免新 terminal 抢走 claude code 焦点。
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
    let previous = {
      sessions: useTerminalStore.getState().sessions,
      customTitles: useTerminalStore.getState().customTitles,
    };
    previousSessionsRef.current = previous.sessions;

    return useTerminalStore.subscribe((state) => {
      if (
        state.sessions === previous.sessions &&
        state.customTitles === previous.customTitles
      ) {
        return;
      }

      const dockApi = currentApiRef.current;
      if (dockApi) {
        reconcileTerminalPanels(dockApi, {
          previousSessions: previous.sessions,
          nextSessions: state.sessions,
          customTitles: state.customTitles,
        });
      }

      previous = {
        sessions: state.sessions,
        customTitles: state.customTitles,
      };
      previousSessionsRef.current = state.sessions;
    });
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

function panelIdFor(sessionId: string): string {
  return `terminal-${sessionId}`;
}

function findLastTerminalPanelId(api: DockviewApi): string | null {
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

function sessionIdFromPanel(
  panel: Pick<IDockviewPanel, 'params'> & { api: Pick<IDockviewPanel['api'], 'id'> },
): string | null {
  const params = panel.params as TerminalPanelParams | undefined;
  if (params?.sessionId) return params.sessionId;
  return panel.api.id.startsWith('terminal-')
    ? panel.api.id.slice('terminal-'.length)
    : null;
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

function consumePendingFocus(
  sessionId: string,
  ref?: { current: string | null },
): boolean {
  if (ref?.current === sessionId) {
    ref.current = null;
    return true;
  }
  if (pendingFocusSessionId === sessionId) {
    pendingFocusSessionId = null;
    return true;
  }
  return false;
}
