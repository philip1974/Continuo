import type { Direction } from 'dockview-react';
import { isPopoutWindow } from '@/lib/popout-mode';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { useTerminalStore } from '@/stores/terminal.store';
import { coApi } from '@/lib/co-api';

export async function splitTerminal(direction: Direction): Promise<void> {
  if (isPopoutWindow()) return;
  const api = getDockApi();
  if (!api) return;
  const group = api.activeGroup;
  if (!group) return;
  const activePanel = group.activePanel;
  const activeSessionId =
    (activePanel?.params as { sessionId?: string } | undefined)?.sessionId ??
    useTerminalStore.getState().activeId;
  const cwd = activeSessionId
    ? useTerminalStore
        .getState()
        .sessions.find((s) => s.id === activeSessionId)?.cwd
    : undefined;
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
