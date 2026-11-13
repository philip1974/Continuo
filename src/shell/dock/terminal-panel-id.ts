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

/**
 * 终端 panel 标题的单一规则(DockReconciler 建 / 改 panel 与 TerminalPanelView 自校正共用;此前各写
 * 一份):用户自定义标题 > session 标题 > 兜底标题(panel params)> `Terminal <id 前 6 位>`;
 * agent 发起的会话加 ` (agent)` 后缀。
 */
export function terminalPanelTitle(input: {
  readonly sessionId: string | undefined;
  readonly customTitle?: string;
  readonly sessionTitle?: string;
  readonly fallbackTitle?: string;
  readonly originHint?: string;
}): string {
  const base =
    input.customTitle ??
    input.sessionTitle ??
    input.fallbackTitle ??
    `Terminal ${(input.sessionId ?? '').slice(0, 6) || '?'}`;
  return input.originHint === 'agent' ? `${base} (agent)` : base;
}
