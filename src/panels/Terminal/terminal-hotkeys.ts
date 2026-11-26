// 终端「让出给命令」的热键(终端拦下该键、不交给 xterm / PTY):命令注册(TerminalPlugin)与终端判定(useTerminal)
// 同一来源,且按**实际生效绑定**判(resolveActiveHotkey:用户改绑 → 跟随新键;解绑或落在 ⌘P / ⌘⇧P 保留键 → 不再让出,
// 按键照常进 shell / 交给 picker)。
// 此前缩放用兄弟包 shouldSkipXtermKey(不分平台)、搜索用 isSearchHotkey(固定 mod+f),均不读改绑:mac 上
// Shift+Ctrl+Enter、改绑 / 解绑后的原默认键被拦下不发给 shell、命令又不匹配,按键被吞。
// 让出与否按**同一张分发表**裁决(winningCommandFor,与全局分发 / 设置页「冲突」标注同表同序):只有胜出命令是终端
// 负责的命令才让出 —— 用户把别的命令绑到 ⌘K / ⌘S 时,终端里不再清屏 / 保存(一键一个动作,对齐 VSCode)。
// 事件所在文档有打开的 Modal → 一律不让出、不执行(对话框期间工作台快捷键不触发)。
import {
  isModalOpenFor,
  winningCommandFor,
  withDefaultCommands,
  type DefaultCommand,
} from '@/plugins/command-palette/useCommandHotkeys';
import { detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { coApp } from '@/plugins/co-app';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import { isContextMenuKey } from '@/lib/context-menu-key';
import { tWithFallback } from '@/i18n';
import { FOCUS_NEXT_PART_COMMAND, FOCUS_PREVIOUS_PART_COMMAND } from '@/shell/focus-parts';
// 显示所有命令的附加默认键 F1:VSCode showCommands 在 commandsToSkipShell 默认列表里 → 终端里让出。
import { SHOW_COMMANDS_COMMAND } from '@/plugins/picker/use-picker-toggle-hotkey';

export const TERMINAL_ZOOM_COMMAND = { id: 'terminal.zoom.toggle', hotkey: 'shift+mod+enter' } as const;
export const TERMINAL_SEARCH_COMMAND = { id: 'terminal.search.toggle', hotkey: 'mod+f' } as const;
/** terminal.clear;hotkey 是 mac 默认键,其它平台默认不绑(见 terminalClearDefaultHotkey)。 */
export const TERMINAL_CLEAR_COMMAND = { id: 'terminal.clear', hotkey: 'mod+k' } as const;
// 工作台命令(由其它模块注册):终端须让出其按键,否则 mac 上 ⌘W / ⌘S 被 xterm 吞。hotkey 是与注册方约定的默认键,
// 仅在命令尚未注册时兜底;已注册则以注册的 hotkey 为准(见 terminalYieldedCommandId),不依赖注册时序。
export const WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND = {
  id: 'workbench.action.closeActiveEditor',
  hotkey: 'mod+w',
} as const;
export const WORKBENCH_SAVE_COMMAND = { id: 'workbench.action.files.save', hotkey: 'mod+s' } as const;
// 重新打开已关闭的编辑器(BDD: src/__tests__/editor-reopen-closed/):同关闭 / 保存,只在按键带 Meta(mac ⇧⌘T)时让出;
// Win/Linux Ctrl+Shift+T 照常进 shell(VSCode commandsToSkipShell 默认列表不含本命令)。
export const WORKBENCH_REOPEN_CLOSED_EDITOR_COMMAND = {
  id: 'workbench.action.reopenClosedEditor',
  hotkey: 'mod+shift+t',
} as const;
// 编辑器组(BDD: src/__tests__/editor-groups/):拆分 ⌘\、聚焦第 N 个编辑器组 ⌘1 / ⌘2 / ⌘3(VSCode 的 focus*EditorGroup 在
// commandsToSkipShell 默认列表里 → 终端里胜出即让出;拆分只在按键带 Meta 时让出,Ctrl+\ 是 shell 的 SIGQUIT)。
export const WORKBENCH_SPLIT_EDITOR_COMMAND = { id: 'workbench.action.splitEditor', hotkey: 'mod+\\' } as const;
export const WORKBENCH_FOCUS_EDITOR_GROUP_COMMANDS = [
  { id: 'workbench.action.focusFirstEditorGroup', hotkey: 'mod+1' },
  { id: 'workbench.action.focusSecondEditorGroup', hotkey: 'mod+2' },
  { id: 'workbench.action.focusThirdEditorGroup', hotkey: 'mod+3' },
] as const;
// ⌃Tab / ⌃⇧Tab 按组内最近使用顺序切换编辑器(BDD: src/__tests__/editor-recent-cycle/):VSCode 终端里 ⌃Tab 同样切编辑器 →
// 胜出即让出(不只 Meta)。与 editor-recent-cycle 的命令常量一致(规范守护)。
export const WORKBENCH_RECENT_EDITOR_COMMANDS = [
  { id: 'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup', hotkey: 'ctrl+tab' },
  { id: 'workbench.action.quickOpenLeastRecentlyUsedEditorInGroup', hotkey: 'ctrl+shift+tab' },
] as const;
/**
 * 切换终端(VSCode workbench.action.terminal.toggleTerminal,各平台 ⌃`;在 commandsToSkipShell 默认列表里 → 终端里胜出即让出:
 * 焦点在终端时按它回到编辑器)。BDD: src/__tests__/terminal-toggle/
 */
export const TERMINAL_TOGGLE_COMMAND = { id: 'workbench.action.terminal.toggleTerminal', hotkey: 'ctrl+`' } as const;
/**
 * 新建终端:主键 ⌘T / Ctrl+T,附加默认键 ⌃⇧`(VSCode workbench.action.terminal.new,在 commandsToSkipShell 默认列表里 →
 * 终端里胜出即让出,不再既发给 shell 又新建终端)。BDD: src/__tests__/workbench-missing-commands/
 */
export const TERMINAL_NEW_COMMAND = {
  id: 'terminal.new',
  hotkey: 'mod+t',
  secondaryHotkeys: ['ctrl+shift+`'] as readonly string[],
} as const;

/**
 * terminal.clear 的默认键:同 VSCode workbench.action.terminal.clear(primary: 0, mac: Cmd+K)只 mac 有 ⌘K;
 * Windows / Linux 不设默认键 —— Ctrl+K 是 shell(readline)的「删到行尾」,须照常进 shell。
 */
export function terminalClearDefaultHotkey(platform: Platform): string | undefined {
  return platform === 'mac' ? TERMINAL_CLEAR_COMMAND.hotkey : undefined;
}

/**
 * 终端让出、交给命令的键(缩放 / 搜索另有专门处理,不在此列)。对齐 VSCode terminalInstance 的判定
 *(`event.metaKey || shouldCommandSkipShell(commandId)`):
 * - terminal.clear 在 commandsToSkipShell 默认列表里 → 胜出即让出;
 * - 关闭编辑器 / 保存不在列表里 → 只有按键带 Meta(mac ⌘)才让出。Win/Linux 上 Ctrl+W(删前一词)/ Ctrl+S
 *  (XOFF)照常进 shell,与 VSCode 一致。
 * - F6 / ⇧F6 区域切换(focusNextPart / focusPreviousPart)在默认列表里 → 胜出即让出(终端吃掉 Tab,键盘用户靠它离开)。
 * - ⌃Tab / ⌃⇧Tab 切换最近使用的编辑器、⌃` 切换终端、⌃⇧` 新建终端、F1 显示所有命令 → 胜出即让出(VSCode 终端里同样生效)。
 */
const SKIP_SHELL_COMMANDS: ReadonlyMap<string, { readonly metaOnly: boolean }> = new Map([
  [TERMINAL_CLEAR_COMMAND.id, { metaOnly: false }],
  [FOCUS_NEXT_PART_COMMAND.id, { metaOnly: false }],
  [FOCUS_PREVIOUS_PART_COMMAND.id, { metaOnly: false }],
  [WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND.id, { metaOnly: true }],
  [WORKBENCH_SAVE_COMMAND.id, { metaOnly: true }],
  [WORKBENCH_REOPEN_CLOSED_EDITOR_COMMAND.id, { metaOnly: true }],
  [WORKBENCH_SPLIT_EDITOR_COMMAND.id, { metaOnly: true }],
  ...WORKBENCH_FOCUS_EDITOR_GROUP_COMMANDS.map((c) => [c.id, { metaOnly: false }] as const),
  ...WORKBENCH_RECENT_EDITOR_COMMANDS.map((c) => [c.id, { metaOnly: false }] as const),
  [TERMINAL_TOGGLE_COMMAND.id, { metaOnly: false }],
  [TERMINAL_NEW_COMMAND.id, { metaOnly: false }],
  [SHOW_COMMANDS_COMMAND.id, { metaOnly: false }],
]);

/** 终端判定涉及的命令的约定默认键(命令尚未注册时兜底;已注册以注册的 hotkey 为准)。按平台(clear 仅 mac 有默认键)。 */
const TERMINAL_DEFAULTS: Readonly<Record<Platform, readonly DefaultCommand[]>> = {
  mac: terminalDefaults('mac'),
  other: terminalDefaults('other'),
};

function terminalDefaults(platform: Platform): readonly DefaultCommand[] {
  return [
    TERMINAL_ZOOM_COMMAND,
    TERMINAL_SEARCH_COMMAND,
    { id: TERMINAL_CLEAR_COMMAND.id, hotkey: terminalClearDefaultHotkey(platform) },
    WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND,
    WORKBENCH_SAVE_COMMAND,
    WORKBENCH_REOPEN_CLOSED_EDITOR_COMMAND,
    WORKBENCH_SPLIT_EDITOR_COMMAND,
    ...WORKBENCH_FOCUS_EDITOR_GROUP_COMMANDS,
    ...WORKBENCH_RECENT_EDITOR_COMMANDS,
    TERMINAL_TOGGLE_COMMAND,
    TERMINAL_NEW_COMMAND,
    SHOW_COMMANDS_COMMAND,
    FOCUS_NEXT_PART_COMMAND,
    FOCUS_PREVIOUS_PART_COMMAND,
  ];
}

interface CommandLookup {
  getAll(): readonly CommandSpec[];
}

type Overrides = Readonly<Record<string, string>>;

/** 按键在分发表里胜出的命令 id(含未注册命令的约定默认键);输入法组合中 / 非 keydown / 有 Modal → null。 */
function terminalWinner(
  event: KeyboardEvent,
  platform: Platform,
  overrides: Overrides,
  registry: CommandLookup,
): string | null {
  if (event.type !== 'keydown' || event.isComposing || isModalOpenFor(event)) return null;
  const commands = withDefaultCommands(registry.getAll(), TERMINAL_DEFAULTS[platform]);
  return winningCommandFor(event, commands, platform, overrides)?.id ?? null;
}

/** 终端应让出给缩放命令的按键。 */
export function isTerminalZoomHotkey(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
  overrides: Overrides = useKeybindingsStore.getState().overrides,
  registry: CommandLookup = coApp.commands,
): boolean {
  return terminalWinner(event, platform, overrides, registry) === TERMINAL_ZOOM_COMMAND.id;
}

/** 终端应拦下并打开搜索条的按键。 */
export function isTerminalSearchHotkey(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
  overrides: Overrides = useKeybindingsStore.getState().overrides,
  registry: CommandLookup = coApp.commands,
): boolean {
  return terminalWinner(event, platform, overrides, registry) === TERMINAL_SEARCH_COMMAND.id;
}

/**
 * 终端应让出给工作台命令(clear / closeActiveEditor / save / reopenClosedEditor / focusNextPart / focusPreviousPart)的按键 → 命令 id;否则 null。
 * 胜出命令按分发表裁决(用户改绑 / 解绑 / 别的命令占了该键都跟随);关闭 / 保存另须按键带 Meta(见 SKIP_SHELL_COMMANDS)。
 */
export function terminalYieldedCommandId(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
  overrides: Overrides = useKeybindingsStore.getState().overrides,
  registry: CommandLookup = coApp.commands,
): string | null {
  const id = terminalWinner(event, platform, overrides, registry);
  if (id === null) return null;
  const rule = SKIP_SHELL_COMMANDS.get(id);
  if (!rule || (rule.metaOnly && !event.metaKey)) return null;
  return id;
}

/**
 * 终端获焦时由终端处理、不交给全局分发的命令(VSCode:终端获焦时不在 commandsToSkipShell 里的键交给 xterm,工作台命令不触发):
 * 后退 / 前进(mac ⌃- / ⌃⇧-,Win/Linux Alt+← / Alt+→)、打开最近(⌃R 是 shell 的反向搜索历史)、切换自动换行(⌥Z)。
 * 带 ⌘(Meta)的按键照常交给工作台(VSCode `event.metaKey` 一律跳过 shell)。id 与注册方一致(规范守护)。
 * BDD: src/__tests__/workbench-missing-commands/、src/__tests__/editor-navigation-history/
 */
export const TERMINAL_KEPT_COMMAND_IDS: ReadonlySet<string> = new Set([
  'workbench.action.navigateBack',
  'workbench.action.navigateForward',
  'workbench.action.openRecent',
  'editor.action.toggleWordWrap',
]);

/** 按键胜出的是终端自己处理的命令(见 TERMINAL_KEPT_COMMAND_IDS):交给 xterm,不冒泡到全局分发。 */
export function isTerminalKeptHotkey(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
  overrides: Overrides = useKeybindingsStore.getState().overrides,
  registry: CommandLookup = coApp.commands,
): boolean {
  if (event.metaKey) return false;
  const id = terminalWinner(event, platform, overrides, registry);
  return id !== null && TERMINAL_KEPT_COMMAND_IDS.has(id);
}

/**
 * 终端让出的键:命令已注册 → 直接执行并截住冒泡(理由同 runTerminalZoomFromKey:无修饰键绑定经全局分发会被
 * A64 放行而吞掉,截住也免得执行两次);尚未注册 → 什么都不做,事件照常冒泡给全局分发(xterm 已因 return false
 * 不再把它发给 shell)。
 */
export function runTerminalCommandFromKey(event: KeyboardEvent, id: string): void {
  const live = coApp.commands.get(id);
  if (!live) return;
  event.preventDefault();
  event.stopPropagation();
  runRegisteredCommand(coApp.commands, id, tWithFallback(live.titleKey, live.title));
}

/**
 * mac 行内编辑键 → 发给 shell 的控制序列(VSCode terminal.contribution 的 registerSendSequenceKeybinding mac 默认绑定):
 * ⌘← = ^A(行首)、⌘→ = ^E(行尾)、⌘⌫ = ^U(删到行首)。xterm 对带 ⌘ 的方向键什么都不发、⌘⌫ 只发 DEL。
 * ⌥← / ⌥→ = ESC b / ESC f(按单词移动):xterm 6 已去掉 mac 上把 ⌥← 改写成 ESC b 的特例,改发 `ESC[1;3D`,
 * zsh / bash 默认 emacs 键表不认(打出 `;3D`)。仅 mac、仅 keydown、恰好该修饰键;其它平台 / 组合 → null(交给 xterm)。
 */
export function terminalSendSequenceForKey(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
): string | null {
  if (platform !== 'mac' || event.type !== 'keydown' || event.isComposing) return null;
  if (event.shiftKey || event.ctrlKey) return null;
  if (event.metaKey && !event.altKey) {
    if (event.key === 'ArrowLeft') return '\x01';
    if (event.key === 'ArrowRight') return '\x05';
    if (event.key === 'Backspace') return '\x15';
    return null;
  }
  if (event.altKey && !event.metaKey) {
    if (event.key === 'ArrowLeft') return '\x1bb';
    if (event.key === 'ArrowRight') return '\x1bf';
  }
  return null;
}

/** 键盘打开终端右键菜单:Shift+F10 / 菜单键(Windows / Linux 约定,mac 上同样可用)。 */
export function isTerminalContextMenuKey(event: KeyboardEvent): boolean {
  return isContextMenuKey(event);
}

/**
 * 终端判中缩放键时**直接执行**缩放命令并截住事件,不依赖冒泡到 document 的全局热键分发:后者对「事件来自可编辑控件
 *(xterm 的 helper textarea)且绑定无 ctrl/meta/alt」的组合一律放行(A64)—— 用户把缩放改绑为 F2 / Shift+Enter 时,
 * 终端让出、全局分发又跳过,按键被吞。截住冒泡也避免带修饰键的绑定被两条路径各执行一次。
 */
export function runTerminalZoomFromKey(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  runRegisteredCommand(coApp.commands, TERMINAL_ZOOM_COMMAND.id, tWithFallback('commands.terminal.zoom.title', 'Toggle Terminal Zoom'));
}

