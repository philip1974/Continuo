// dockview panel id <-> terminal session id 之间的桥接。
// 集中一处避免 'terminal-' 前缀字面量散落,以及 params.sessionId 解析逻辑分散。

import type { IDockviewPanel } from 'dockview-react';

export const TERMINAL_PANEL_ID_PREFIX = 'terminal-';

export function panelIdFor(sessionId: string): string {
  return `${TERMINAL_PANEL_ID_PREFIX}${sessionId}`;
}

interface PanelLike {
  readonly params: unknown;
  readonly api: Pick<IDockviewPanel['api'], 'id'>;
}

export function sessionIdFromPanel(panel: PanelLike): string | null {
  const params = panel.params as { sessionId?: string } | undefined;
  if (params?.sessionId) return params.sessionId;
  return panel.api.id.startsWith(TERMINAL_PANEL_ID_PREFIX)
    ? panel.api.id.slice(TERMINAL_PANEL_ID_PREFIX.length)
    : null;
}

export function isTerminalPanelId(panelId: string): boolean {
  return panelId.startsWith(TERMINAL_PANEL_ID_PREFIX);
}
