// dockview panel id <-> terminal session id 之间的桥接。
// 集中一处避免 'terminal-' 前缀字面量散落,以及 params.sessionId 解析逻辑分散。

import type { IDockviewPanel } from 'dockview-react';
import { t } from '@/i18n';
import { UNTRUSTED_LABEL_MAX_CHARS, visibleUntrustedText } from '@/lib/untrusted-text';
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

/** tab 标题里 agent 标签后缀的显示上限(码位;超出中间截断)。 */
const AGENT_LABEL_TITLE_MAX_CHARS = 32;

/**
 * 终端 panel 标题的单一规则(DockReconciler 建 / 改 panel 与 TerminalPanelView 自校正共用;此前各写
 * 一份)。基础名优先级(对齐 VSCode:重命名 / 扩展 createTerminal({ name }) 都是 TitleEventSource.Api 固定、默认模板 `${process}`;
 * 程序经 OSC 0 / 2 设的标题 `${sequence}` 不在默认模板里,不显示):用户重命名 > agent 创建时给的名字(create_session name)>
 * 前台进程名(shell 空闲时即 shell 名,如 zsh;运行程序时如 vim)> 进程名未知时:未命名会话按当前语言「终端 N」> session 标题 >
 * `Terminal <id 前 6 位>`;agent 发起的会话加 ` (<agentLabel>)` 后缀(未给标签时 ` (agent)`);进程已退出再加本地化「(已退出)」后缀。
 * agent 给的名字 / 标签可见化后显示(换行、控制 / 双向字符替换,超长截断:lib/untrusted-text)。
 */
export function terminalPanelTitle(input: TerminalTitleInput): string {
  const base = terminalBaseTitle(input);
  const titled = input.originHint === 'agent' ? `${base} (${agentLabelOf(input)})` : base;
  return input.exited ? `${titled} ${t('panels.terminal.exited_suffix')}` : titled;
}

function agentLabelOf(input: TerminalTitleInput): string {
  return input.agentLabel ? visibleUntrustedText(input.agentLabel, AGENT_LABEL_TITLE_MAX_CHARS) : 'agent';
}

/**
 * 终端输入框的可访问名(VSCode terminalInstance:「Terminal {id}, {title}」/ 无标题时「Terminal {id}」):有默认序号 →
 * 「终端 N,标题」(标题就是「终端 N」本身时只读「终端 N」);无序号 →「终端,标题」。标题同面板 tab(terminalPanelTitle)。
 * BDD: src/__tests__/terminal-screen-reader/
 */
export function terminalInputAriaLabel(input: TerminalTitleInput): string {
  const title = terminalPanelTitle(input);
  const n = input.defaultTitleIndex;
  if (n === undefined) return t('panels.terminal.input_aria_label', { title });
  if (title === t('panels.terminal.default_title', { n })) return title;
  return t('panels.terminal.input_aria_label_numbered', { n, title });
}

export interface TerminalTitleInput {
  readonly sessionId: string | undefined;
  readonly sessionTitle?: string;
  readonly defaultTitleIndex?: number;
  readonly originHint?: string;
  readonly exited?: boolean;
  readonly userTitle?: string;
  readonly processName?: string;
  /** agent 会话创建时自报的标签(create_session agentLabel,如 claude / codex);tab 后缀显示它。 */
  readonly agentLabel?: string;
}

/** 不含 agent 标签 /「已退出」后缀的基础名(见 terminalPanelTitle;重命名框以它预填)。 */
export function terminalBaseTitle(input: TerminalTitleInput): string {
  if (input.userTitle) return input.userTitle;
  // agent 显式命名(main 只给未命名会话分配 defaultTitleIndex):VSCode createTerminal({ name }) 的名字固定,不被进程名覆盖。
  if (input.originHint === 'agent' && input.defaultTitleIndex === undefined && input.sessionTitle) {
    return visibleUntrustedText(input.sessionTitle, UNTRUSTED_LABEL_MAX_CHARS);
  }
  // 已退出:前台程序随之结束(main 也会清 processName,这里防快照先后)。
  if (input.processName && !input.exited) return input.processName;
  return input.defaultTitleIndex !== undefined
    ? t('panels.terminal.default_title', { n: input.defaultTitleIndex })
    : (input.sessionTitle ?? `Terminal ${(input.sessionId ?? '').slice(0, 6) || '?'}`);
}

/** 会话快照 → 标题输入(DockReconciler / TerminalPanelView / 重命名框共用)。 */
export function terminalTitleInputOf(session: TerminalSessionSnapshot): TerminalTitleInput {
  return {
    sessionId: session.id,
    sessionTitle: session.title,
    defaultTitleIndex: session.defaultTitleIndex,
    originHint: session.originHint,
    exited: session.exitCode !== null,
    userTitle: session.userTitle,
    processName: session.processName,
    agentLabel: session.agentLabel,
  };
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
