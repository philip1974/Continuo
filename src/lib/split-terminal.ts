import type { Direction } from 'dockview-react';
import { isPopoutWindow } from '@/lib/popout-mode';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { useTerminalStore } from '@/stores/terminal.store';
import { coApi } from '@/lib/co-api';

type TerminalPanelParams = {
  sessionId?: string;
  cwd?: string;
  title?: string;
  role?: string;
};

function getProcessCwd(): string | undefined {
  try {
    if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
      return process.cwd();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export async function splitTerminal(direction: Direction): Promise<void> {
  if (isPopoutWindow()) return;
  const api = getDockApi();
  if (!api) return;
  const group = api.activeGroup;
  if (!group) return;
  const activePanel = group.activePanel;
  const activePanelParams = activePanel?.params as TerminalPanelParams | undefined;
  const terminalState = useTerminalStore.getState();
  const activeSessionId =
    activePanelParams?.sessionId ?? terminalState.activeId;
  const trackedCwd = activeSessionId
    ? terminalState.sessions.find((s) => s.id === activeSessionId)?.cwd
    : undefined;
  const cwd = trackedCwd ?? activePanelParams?.cwd ?? getProcessCwd();
  const r = await coApi.terminal.create({ cwd, scoped: true });
  if (!r.ok || !r.data?.id) return;
  const data = r.data as { id: string; title?: string };
  api.addPanel({
    id: `terminal-${data.id}`,
    component: 'terminal',
    title: data.title ?? 'Terminal',
    position: { referenceGroup: group, direction },
    params: {
      sessionId: data.id,
      cwd,
      title: data.title,
      role: 'split',
    },
  });
}
