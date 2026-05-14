import type { Direction } from 'dockview-react';
import { isPopoutWindow } from '@/lib/popout-mode';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { useTerminalStore } from '@/stores/terminal.store';
import { coApi } from '@/lib/co-api';
import { getPaneController } from '@/panels/Terminal/PaneControllerRegistry';
import type { SplitDirection } from '@/panels/Terminal/paneTree';

export async function splitTerminal(direction: Direction | SplitDirection): Promise<void> {
  if (isPopoutWindow()) return;
  const api = getDockApi();
  if (!api) return;
  const group = api.activeGroup;
  if (!group) return;
  const activePanel = group.activePanel;
  const panelId = activePanel?.api?.id;
  if (panelId) {
    const controller = getPaneController(coApi.system.windowId, panelId);
    if (controller) {
      controller.split(toPaneDirection(direction));
      return;
    }
  }
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
    position: { referenceGroup: group, direction: toDockviewDirection(direction) },
    params: {
      sessionId: data.id,
      cwd,
      title: data.title,
      role: 'split',
    },
  });
}

export function focusTerminalPane(direction: 'prev' | 'next'): void {
  if (isPopoutWindow()) return;
  const api = getDockApi();
  const panelId = api?.activeGroup?.activePanel?.api?.id;
  if (!panelId) return;
  const controller = getPaneController(coApi.system.windowId, panelId);
  if (!controller) return;
  if (direction === 'prev') controller.focusPrev();
  else controller.focusNext();
}

function toPaneDirection(direction: Direction | SplitDirection): SplitDirection {
  return direction === 'below' || direction === 'vertical' ? 'vertical' : 'horizontal';
}

function toDockviewDirection(direction: Direction | SplitDirection): Direction {
  return direction === 'vertical' ? 'below' : direction === 'horizontal' ? 'right' : direction;
}
