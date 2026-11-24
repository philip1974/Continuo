// dockview panel id <-> terminal session id 之间的桥接。
// 集中一处避免 'terminal-' 前缀字面量散落,以及 params.sessionId 解析逻辑分散。

import type { IDockviewPanel } from 'dockview-react';
import { t } from '@/i18n';
import type { TerminalSessionSnapshot } from '../../../electron/shared/terminal-session';

const TERMINAL_PANEL_ID_PREFIX = 'terminal-';

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

/**
 * 终端 panel 标题的单一规则(DockReconciler 建 / 改 panel 与 TerminalPanelView 自校正共用;此前各写
 * 一份):未命名会话(有 defaultTitleIndex)按当前语言显示「终端 N」> session 标题 > `Terminal <id 前 6 位>`;
 * agent 发起的会话加 ` (agent)` 后缀;进程已退出再加本地化「(已退出)」后缀。
 */
export function terminalPanelTitle(input: {
  readonly sessionId: string | undefined;
  readonly sessionTitle?: string;
  readonly defaultTitleIndex?: number;
  readonly originHint?: string;
  readonly exited?: boolean;
}): string {
  const base =
    input.defaultTitleIndex !== undefined
      ? t('panels.terminal.default_title', { n: input.defaultTitleIndex })
      : (input.sessionTitle ?? `Terminal ${(input.sessionId ?? '').slice(0, 6) || '?'}`);
  const titled = input.originHint === 'agent' ? `${base} (agent)` : base;
  return input.exited ? `${titled} ${t('panels.terminal.exited_suffix')}` : titled;
}

/**
 * 进程退出后是否自动关闭终端面板(VSCode:退出码 0 静默关闭)。只对 user 会话:关闭面板会删除 main 侧会话记录,
 * agent(MCP)之后 list_sessions 就看不到 exit_code —— agent 会话保留面板,显示退出说明等用户关闭。
 */
export function shouldAutoCloseExitedSession(
  session: Pick<TerminalSessionSnapshot, 'exitCode' | 'originHint'>,
): boolean {
  return session.exitCode === 0 && session.originHint === 'user';
}
