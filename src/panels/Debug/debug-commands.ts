// 调试工具栏命令(VSCode debugCommands / debugToolBar):继续 / 暂停 / 单步跳过 / 单步调试 / 单步跳出 / 停止。
// 作用于本窗口显示的调试会话(已停住的优先,见 selectDisplayedSession),含 agent 启动的会话 —— 用户随时接管。
// 默认键照 VSCode(各平台相同):F5 继续(when debugState == stopped)、F6 暂停(running)、F10 单步跳过(stopped)、
// F11 单步调试(inDebugMode)、⇧F11 单步跳出(stopped)、⇧F5 停止(inDebugMode)。条件不成立时同键让给后面的绑定(无会话时 F5
// 不做调试动作);命令面板执行不受 when 限制,按会话状态判定(运行中「继续」等为无操作)。
// 重启(⇧⌘F5)不做:会话由 agent 经 MCP 启动并归它控制,重新 launch 会换会话 id、脱离 agent。
// BDD: src/__tests__/debug-user-controls/

import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { provideDebugState, type CommandWhen, type DebugStateValue } from '@/lib/editor-text-focus';
import { selectDisplayedSession, useDebugStore } from '@/stores/debug.store';
import type { DebugControlAction } from '../../../electron/shared/debug-view-channels';

export interface DebugCommandDef {
  readonly id: string;
  readonly action: DebugControlAction;
  readonly title: string;
  readonly titleKey: string;
  readonly hotkey: string;
  readonly when: CommandWhen;
  /** 该动作在哪些会话状态下可用(工具栏按钮的 disabled 与命令面板执行共用)。 */
  readonly enabledIn: readonly DebugStateValue[];
}

export const DEBUG_COMMANDS: readonly DebugCommandDef[] = [
  {
    id: 'workbench.action.debug.continue',
    action: 'continue',
    title: 'Continue',
    titleKey: 'commands.debug.continue.title',
    hotkey: 'f5',
    when: 'debugStopped',
    enabledIn: ['stopped'],
  },
  {
    id: 'workbench.action.debug.pause',
    action: 'pause',
    title: 'Pause',
    titleKey: 'commands.debug.pause.title',
    hotkey: 'f6',
    when: 'debugRunning',
    enabledIn: ['running'],
  },
  {
    id: 'workbench.action.debug.stepOver',
    action: 'stepOver',
    title: 'Step Over',
    titleKey: 'commands.debug.step_over.title',
    hotkey: 'f10',
    when: 'debugStopped',
    enabledIn: ['stopped'],
  },
  {
    id: 'workbench.action.debug.stepInto',
    action: 'stepIn',
    title: 'Step Into',
    titleKey: 'commands.debug.step_into.title',
    hotkey: 'f11',
    when: 'inDebugMode',
    // VSCode 运行中也可按(adapter 忽略);这里只在停住时真正发出,运行中为无操作。
    enabledIn: ['stopped'],
  },
  {
    id: 'workbench.action.debug.stepOut',
    action: 'stepOut',
    title: 'Step Out',
    titleKey: 'commands.debug.step_out.title',
    hotkey: 'shift+f11',
    when: 'debugStopped',
    enabledIn: ['stopped'],
  },
  {
    id: 'workbench.action.debug.stop',
    action: 'stop',
    title: 'Stop',
    titleKey: 'commands.debug.stop.title',
    hotkey: 'shift+f5',
    when: 'inDebugMode',
    enabledIn: ['running', 'stopped'],
  },
];

/** 本窗口显示的调试会话状态。 */
export function displayedDebugState(state = useDebugStore.getState()): DebugStateValue {
  const session = selectDisplayedSession(state);
  if (!session) return 'inactive';
  return session.stopped ? 'stopped' : 'running';
}

provideDebugState(() => displayedDebugState());

/** 对显示的会话执行动作;没有会话或当前状态下不可用 → 无操作。 */
export function runDebugAction(action: DebugControlAction): Promise<void> {
  const state = useDebugStore.getState();
  const session = selectDisplayedSession(state);
  const def = DEBUG_COMMANDS.find((cmd) => cmd.action === action);
  if (!session || !def?.enabledIn.includes(displayedDebugState(state))) return Promise.resolve();
  return state.control(session.id, action);
}

export function debugCommandSpecs(): CommandSpec[] {
  return DEBUG_COMMANDS.map((cmd) => ({
    id: cmd.id,
    title: cmd.title,
    titleKey: cmd.titleKey,
    category: 'Debug',
    categoryKey: 'commands.debug.category',
    hotkey: cmd.hotkey,
    when: cmd.when,
    fn: () => runDebugAction(cmd.action),
  }));
}
