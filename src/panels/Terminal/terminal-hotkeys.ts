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
import { isWindowsRuntime } from '@/lib/path-cross';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import { isContextMenuKey } from '@/lib/context-menu-key';
import { tWithFallback } from '@/i18n';
import { FOCUS_NEXT_PART_COMMAND, FOCUS_PREVIOUS_PART_COMMAND } from '@/shell/focus-parts';
// 显示所有命令的附加默认键 F1:VSCode showCommands 在 commandsToSkipShell 默认列表里 → 终端里让出。
import { isPickerToggleKey, SHOW_COMMANDS_COMMAND } from '@/plugins/picker/use-picker-toggle-hotkey';
import { WINDOW_ZOOM_COMMAND_IDS } from '../../../electron/shared/window-zoom';
import {
  TERMINAL_FOCUS_NEXT_COMMAND_ID,
  TERMINAL_FOCUS_NEXT_PANE_COMMAND_ID,
  TERMINAL_FOCUS_PREVIOUS_COMMAND_ID,
  TERMINAL_FOCUS_PREVIOUS_PANE_COMMAND_ID,
} from '@/shell/dock/terminal-focus-cycle';

/** 切换全屏命令 id(window-commands 注册;终端让出用,规范守护两处一致)。 */
export const TOGGLE_FULL_SCREEN_COMMAND_ID = 'workbench.action.toggleFullScreen';

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
// 另存为 ⇧⌘S / 新建无标题文件 ⌘N(BDD: src/__tests__/editor-save-as/):同保存,只在按键带 Meta 时让出(Win/Linux Ctrl+N 是 readline 的
// 下一条历史,照常进 shell;VSCode 终端里 `event.metaKey` 一律跳过 shell)。与 editor-commands 的命令常量一致(规范守护)。
export const WORKBENCH_SAVE_AS_COMMAND = { id: 'workbench.action.files.saveAs', hotkey: 'mod+shift+s' } as const;
export const WORKBENCH_NEW_UNTITLED_FILE_COMMAND = { id: 'workbench.action.files.newUntitledFile', hotkey: 'mod+n' } as const;
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
  { id: 'workbench.action.focusFourthEditorGroup', hotkey: 'mod+4' },
  { id: 'workbench.action.focusFifthEditorGroup', hotkey: 'mod+5' },
  { id: 'workbench.action.focusSixthEditorGroup', hotkey: 'mod+6' },
  { id: 'workbench.action.focusSeventhEditorGroup', hotkey: 'mod+7' },
  { id: 'workbench.action.focusEighthEditorGroup', hotkey: 'mod+8' },
] as const;
/**
 * 下一个 / 上一个编辑器(含组内版本)与组内最后一个编辑器(VSCode 同 id,都在 commandsToSkipShell 默认列表里;各平台默认键不同,由
 * editor-commands 注册,此处只列 id)。BDD: src/__tests__/editor-tab-management/
 */
const WORKBENCH_ADJACENT_EDITOR_COMMAND_IDS = [
  'workbench.action.nextEditor',
  'workbench.action.previousEditor',
  'workbench.action.nextEditorInGroup',
  'workbench.action.previousEditorInGroup',
  'workbench.action.lastEditorInGroup',
] as const;
/**
 * 移动编辑器(mac ⌃⌘← / ⌃⌘→ / ⌃⌘1 / ⌃⌘9;Windows / Linux Ctrl+Alt+← / → 等):不在 commandsToSkipShell 默认列表 → 只有带 Meta 时让出
 *(VSCode `event.metaKey` 跳过 shell);不带 Meta 的(Windows / Linux)由终端处理、交给 shell(见 TERMINAL_KEPT_COMMAND_IDS)。
 */
export const WORKBENCH_MOVE_EDITOR_COMMAND_IDS = [
  'workbench.action.moveEditorToPreviousGroup',
  'workbench.action.moveEditorToNextGroup',
  'workbench.action.moveEditorToFirstGroup',
  'workbench.action.moveEditorToLastGroup',
  'workbench.action.moveEditorLeftInGroup',
  'workbench.action.moveEditorRightInGroup',
] as const;
/** 按序号打开编辑器(mac ⌃1…⌃9、Windows / Linux Alt+1…Alt+9):不在 commandsToSkipShell 默认列表 → 终端获焦时交给 shell(VSCode 同)。 */
export const WORKBENCH_OPEN_EDITOR_AT_INDEX_COMMAND_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
  (n) => `workbench.action.openEditorAtIndex${n}`,
);
// ⌃Tab / ⌃⇧Tab 按组内最近使用顺序切换编辑器(BDD: src/__tests__/editor-recent-cycle/):VSCode 终端里 ⌃Tab 同样切编辑器 →
// 胜出即让出(不只 Meta)。与 editor-recent-cycle 的命令常量一致(规范守护)。
export const WORKBENCH_RECENT_EDITOR_COMMANDS = [
  { id: 'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup', hotkey: 'ctrl+tab' },
  { id: 'workbench.action.quickOpenLeastRecentlyUsedEditorInGroup', hotkey: 'ctrl+shift+tab' },
] as const;
/**
 * 切换终端(VSCode workbench.action.terminal.toggleTerminal,各平台 ⌃`;在 commandsToSkipShell 默认列表里 → 终端里胜出即让出:
 * 焦点在终端时按它回到编辑器)。BDD: src/__tests__/terminal-toggle/
 * 附加默认键 ⌘J / Ctrl+J:VSCode 的「切换面板」(workbench.action.togglePanel,终端所在的面板;同在 commandsToSkipShell 默认列表)。
 * 本项目没有独立的底部面板,终端即面板 → 并到切换终端。BDD: src/__tests__/workbench-vscode-default-keys/
 */
export const TERMINAL_TOGGLE_COMMAND = {
  id: 'workbench.action.terminal.toggleTerminal',
  hotkey: 'ctrl+`',
  secondaryHotkeys: ['mod+j'] as readonly string[],
} as const;
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
 * 拆分终端(VSCode workbench.action.terminal.split,when terminalFocus):mac ⌘\(附加 ⌃⇧5),Windows / Linux Ctrl+Shift+5。
 * 终端获焦时压过同键的拆分编辑器(带 when 的绑定先判);在 commandsToSkipShell 默认列表里 → 胜出即让出。
 * BDD: src/__tests__/terminal-split/
 */
export const TERMINAL_SPLIT_COMMAND_ID = 'workbench.action.terminal.split';
export const TERMINAL_SPLIT_WHEN = 'terminalFocus' as const;

export function terminalSplitDefaultHotkeys(platform: Platform): {
  readonly hotkey: string;
  readonly secondaryHotkeys?: readonly string[];
} {
  return platform === 'mac' ? { hotkey: 'mod+\\', secondaryHotkeys: ['ctrl+shift+5'] } : { hotkey: 'ctrl+shift+5' };
}

/**
 * 终端复制 / 粘贴(VSCode terminal.clipboard.contribution 的 CopySelection / CopyAndClearSelection / Paste,同 id、同标题;都在
 * commandsToSkipShell 默认列表里 → 胜出即让出)。默认键同 VSCode:
 * - 复制所选内容:Windows / Linux Ctrl+Shift+C(when 终端获焦且有选区);
 * - 复制并清除选区:Windows Ctrl+C(同 when —— 没有选区时不胜出,Ctrl+C 照常发 ^C 给 shell);
 * - 粘贴到活动终端:Windows Ctrl+V(附加 Ctrl+Shift+V)、Linux Ctrl+Shift+V(when 终端获焦)。
 * macOS 不设默认键:⌘C / ⌘V 照旧由浏览器原生复制 / 粘贴(粘贴经 installTerminalPasteSanitizer 净化)—— Continuo 偏离:VSCode mac
 * 把 ⌘C / ⌘V 绑给这两个命令,行为相同。Linux 的 Shift+Insert(VSCode PasteSelection 粘贴主选区)未做:Chromium 默认把它当粘贴剪贴板。
 * 键盘与右键菜单同走 useTerminal 的 contextMenuActions(粘贴先净化控制字符,防 pastejacking)。BDD: src/__tests__/win-linux-parity/
 */
export const TERMINAL_COPY_SELECTION_COMMAND_ID = 'workbench.action.terminal.copySelection';
export const TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND_ID = 'workbench.action.terminal.copyAndClearSelection';
export const TERMINAL_PASTE_COMMAND_ID = 'workbench.action.terminal.paste';
export const TERMINAL_TEXT_SELECTED_WHEN = 'terminalTextSelectedFocus' as const;
export const TERMINAL_FOCUS_WHEN = 'terminalFocus' as const;

/** 操作系统(复制 / 粘贴默认键 Windows 与 Linux 不同;Platform 不区分)。 */
export type TerminalOs = 'mac' | 'windows' | 'linux';

export function detectTerminalOs(platform: Platform = detectPlatform()): TerminalOs {
  if (platform === 'mac') return 'mac';
  return isWindowsRuntime() ? 'windows' : 'linux';
}

type DefaultHotkeys = { readonly hotkey?: string; readonly secondaryHotkeys?: readonly string[] };

export interface TerminalClipboardCommand {
  readonly id: string;
  readonly title: string;
  readonly titleKey: string;
  readonly when: typeof TERMINAL_TEXT_SELECTED_WHEN | typeof TERMINAL_FOCUS_WHEN;
  readonly action: 'copy' | 'copyAndClear' | 'paste';
  readonly keys: Readonly<Record<TerminalOs, DefaultHotkeys>>;
}

export const TERMINAL_CLIPBOARD_COMMANDS: readonly TerminalClipboardCommand[] = [
  {
    id: TERMINAL_COPY_SELECTION_COMMAND_ID,
    title: 'Copy Selection',
    titleKey: 'commands.terminal.copySelection.title',
    when: TERMINAL_TEXT_SELECTED_WHEN,
    action: 'copy',
    keys: { mac: {}, windows: { hotkey: 'ctrl+shift+c' }, linux: { hotkey: 'ctrl+shift+c' } },
  },
  {
    id: TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND_ID,
    title: 'Copy and Clear Selection',
    titleKey: 'commands.terminal.copyAndClearSelection.title',
    when: TERMINAL_TEXT_SELECTED_WHEN,
    action: 'copyAndClear',
    keys: { mac: {}, windows: { hotkey: 'ctrl+c' }, linux: {} },
  },
  {
    id: TERMINAL_PASTE_COMMAND_ID,
    title: 'Paste into Active Terminal',
    titleKey: 'commands.terminal.paste.title',
    when: TERMINAL_FOCUS_WHEN,
    action: 'paste',
    keys: { mac: {}, windows: { hotkey: 'ctrl+v', secondaryHotkeys: ['ctrl+shift+v'] }, linux: { hotkey: 'ctrl+shift+v' } },
  },
];

/**
 * 调试工具栏命令(VSCode workbench.action.debug.continue / pause / stepOver / stepInto / stepOut / stop,都在 commandsToSkipShell 默认
 * 列表里 → 胜出即让出):调试会话停住时焦点在终端也能按 F5 / F10 / F11 …(没有会话时 when 不成立、不胜出,F5 照常进 shell)。
 * id 与 debug-commands 的 DEBUG_COMMANDS 一致(规范守护)。
 */
export const TERMINAL_YIELDED_DEBUG_COMMAND_IDS = [
  'workbench.action.debug.continue',
  'workbench.action.debug.pause',
  'workbench.action.debug.stepOver',
  'workbench.action.debug.stepInto',
  'workbench.action.debug.stepOut',
  'workbench.action.debug.stop',
] as const;

/** 终端滚动动作(终端面板句柄 scroll 执行:scrollToTop / scrollToBottom / scrollPages(±1) / scrollLines(±1))。 */
export type TerminalScrollAction = 'top' | 'bottom' | 'pageUp' | 'pageDown' | 'lineUp' | 'lineDown';

/**
 * 终端滚动命令(VSCode terminalActions 的 ScrollToTop / ScrollToBottom / ScrollUpPage / ScrollDownPage / ScrollUpLine / ScrollDownLine,
 * 同 id、同标题;在 commandsToSkipShell 默认列表里 → 胜出即让出)。when = 终端获焦且在主缓冲(VSCode focusInAny_and_normalBuffer):
 * vim / less 等全屏程序的备用屏里不生效,按键交给程序。
 * 默认键同 VSCode:mac ⌘Home / ⌘End / PageUp / PageDown / ⌥⌘PageUp / ⌥⌘PageDown;Windows Ctrl+Home / Ctrl+End / ⇧PageUp /
 * ⇧PageDown / Ctrl+Alt+PageUp / Ctrl+Alt+PageDown(Platform 不区分 Linux,Linux 同 Windows —— VSCode Linux 是 ⇧Home / ⇧End /
 * Ctrl+⇧↑ / Ctrl+⇧↓)。mac 另把 ⌘PageUp / ⌘PageDown 作翻页的附加默认键(Continuo 偏离:mac 终端惯例,VSCode 未绑时会把 `ESC[5~`
 * 发给 shell)。BDD: src/__tests__/terminal-scroll-commands/
 */
export interface TerminalScrollCommand {
  readonly id: string;
  readonly action: TerminalScrollAction;
  readonly title: string;
  readonly titleKey: string;
  readonly mac: { readonly hotkey: string; readonly secondaryHotkeys?: readonly string[] };
  readonly other: { readonly hotkey: string };
}

export const TERMINAL_SCROLL_WHEN = 'terminalNormalBufferFocus' as const;

export const TERMINAL_SCROLL_COMMANDS: readonly TerminalScrollCommand[] = [
  {
    id: 'workbench.action.terminal.scrollToTop',
    action: 'top',
    title: 'Scroll to Top',
    titleKey: 'commands.terminal.scrollToTop.title',
    mac: { hotkey: 'mod+home' },
    other: { hotkey: 'mod+home' },
  },
  {
    id: 'workbench.action.terminal.scrollToBottom',
    action: 'bottom',
    title: 'Scroll to Bottom',
    titleKey: 'commands.terminal.scrollToBottom.title',
    mac: { hotkey: 'mod+end' },
    other: { hotkey: 'mod+end' },
  },
  {
    id: 'workbench.action.terminal.scrollUpPage',
    action: 'pageUp',
    title: 'Scroll Up (Page)',
    titleKey: 'commands.terminal.scrollUpPage.title',
    mac: { hotkey: 'pageup', secondaryHotkeys: ['mod+pageup'] },
    other: { hotkey: 'shift+pageup' },
  },
  {
    id: 'workbench.action.terminal.scrollDownPage',
    action: 'pageDown',
    title: 'Scroll Down (Page)',
    titleKey: 'commands.terminal.scrollDownPage.title',
    mac: { hotkey: 'pagedown', secondaryHotkeys: ['mod+pagedown'] },
    other: { hotkey: 'shift+pagedown' },
  },
  {
    id: 'workbench.action.terminal.scrollUp',
    action: 'lineUp',
    title: 'Scroll Up (Line)',
    titleKey: 'commands.terminal.scrollUpLine.title',
    mac: { hotkey: 'mod+alt+pageup' },
    other: { hotkey: 'mod+alt+pageup' },
  },
  {
    id: 'workbench.action.terminal.scrollDown',
    action: 'lineDown',
    title: 'Scroll Down (Line)',
    titleKey: 'commands.terminal.scrollDownLine.title',
    mac: { hotkey: 'mod+alt+pagedown' },
    other: { hotkey: 'mod+alt+pagedown' },
  },
];

/** 滚动命令在该平台的默认键(主键 + 附加默认键)。 */
export function terminalScrollDefaultHotkeys(
  command: TerminalScrollCommand,
  platform: Platform,
): { readonly hotkey: string; readonly secondaryHotkeys?: readonly string[] } {
  return platform === 'mac' ? command.mac : command.other;
}

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
 * - 下一个 / 上一个终端(⇧⌘] / ⇧⌘[,Ctrl+PageDown / PageUp)、下一个 / 上一个窗格(⌥⌘→ / ⌥⌘←,Alt+→ / Alt+←)→ 胜出即让出;
 *   窗格命令只在该窗口有不止一个终端窗格时胜出(when: terminalSplitFocus = VSCode terminalFocus && terminalSplitActive),
 *   没有分屏时 mac ⌥⌘→ / ⌥⌘← 归下一个 / 上一个编辑器(同在默认列表里,让出),Windows / Linux Alt+→ / Alt+← 照常进 shell。
 *   BDD: src/__tests__/terminal-focus-cycle/
 */
const SKIP_SHELL_COMMANDS: ReadonlyMap<string, { readonly metaOnly: boolean }> = new Map<string, { readonly metaOnly: boolean }>([
  [TERMINAL_CLEAR_COMMAND.id, { metaOnly: false }],
  [FOCUS_NEXT_PART_COMMAND.id, { metaOnly: false }],
  [FOCUS_PREVIOUS_PART_COMMAND.id, { metaOnly: false }],
  [WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND.id, { metaOnly: true }],
  [WORKBENCH_SAVE_COMMAND.id, { metaOnly: true }],
  [WORKBENCH_SAVE_AS_COMMAND.id, { metaOnly: true }],
  [WORKBENCH_NEW_UNTITLED_FILE_COMMAND.id, { metaOnly: true }],
  [WORKBENCH_REOPEN_CLOSED_EDITOR_COMMAND.id, { metaOnly: true }],
  [WORKBENCH_SPLIT_EDITOR_COMMAND.id, { metaOnly: true }],
  ...WORKBENCH_FOCUS_EDITOR_GROUP_COMMANDS.map((c) => [c.id, { metaOnly: false }] as const),
  ...WORKBENCH_RECENT_EDITOR_COMMANDS.map((c) => [c.id, { metaOnly: false }] as const),
  [TERMINAL_TOGGLE_COMMAND.id, { metaOnly: false }],
  [TERMINAL_NEW_COMMAND.id, { metaOnly: false }],
  [TERMINAL_SPLIT_COMMAND_ID, { metaOnly: false }],
  [SHOW_COMMANDS_COMMAND.id, { metaOnly: false }],
  [TERMINAL_FOCUS_NEXT_COMMAND_ID, { metaOnly: false }],
  [TERMINAL_FOCUS_PREVIOUS_COMMAND_ID, { metaOnly: false }],
  [TERMINAL_FOCUS_NEXT_PANE_COMMAND_ID, { metaOnly: false }],
  [TERMINAL_FOCUS_PREVIOUS_PANE_COMMAND_ID, { metaOnly: false }],
  ...WORKBENCH_ADJACENT_EDITOR_COMMAND_IDS.map((id) => [id, { metaOnly: false }] as const),
  ...WORKBENCH_MOVE_EDITOR_COMMAND_IDS.map((id) => [id, { metaOnly: true }] as const),
  // 放大 / 缩小 / 重置缩放(⌘= / ⌘- / ⌘0):不在 commandsToSkipShell 默认列表 → 只有带 Meta 时让出(VSCode 同;Win/Linux 的
  // Ctrl+= / Ctrl+- 照常进 shell)。BDD: src/__tests__/window-zoom/
  ...WINDOW_ZOOM_COMMAND_IDS.map((id) => [id, { metaOnly: true }] as const),
  // 切换全屏(F11 / mac ⌃⌘F):在 commandsToSkipShell 默认列表里 → 胜出即让出(BDD: src/__tests__/workbench-layout-visibility/)
  [TOGGLE_FULL_SCREEN_COMMAND_ID, { metaOnly: false }],
  // 滚动(⌘Home / ⌘End / PageUp …):在 commandsToSkipShell 默认列表里 → 胜出即让出(when 限主缓冲,备用屏里不胜出)。
  ...TERMINAL_SCROLL_COMMANDS.map((c) => [c.id, { metaOnly: false }] as const),
  // 复制 / 粘贴(Windows Ctrl+C 有选区 / Ctrl+V,Ctrl+Shift+C / Ctrl+Shift+V):在默认列表里 → 胜出即让出。
  ...TERMINAL_CLIPBOARD_COMMANDS.map((c) => [c.id, { metaOnly: false }] as const),
  ...TERMINAL_YIELDED_DEBUG_COMMAND_IDS.map((id) => [id, { metaOnly: false }] as const),
]);

/** 终端判定涉及的命令的约定默认键(命令尚未注册时兜底;已注册以注册的 hotkey 为准)。按平台(clear 仅 mac 有默认键)。 */
const TERMINAL_DEFAULTS: Readonly<Record<TerminalOs, readonly DefaultCommand[]>> = {
  mac: terminalDefaults('mac', 'mac'),
  windows: terminalDefaults('other', 'windows'),
  linux: terminalDefaults('other', 'linux'),
};

function terminalDefaults(platform: Platform, os: TerminalOs): readonly DefaultCommand[] {
  return [
    TERMINAL_ZOOM_COMMAND,
    TERMINAL_SEARCH_COMMAND,
    { id: TERMINAL_CLEAR_COMMAND.id, hotkey: terminalClearDefaultHotkey(platform) },
    WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND,
    WORKBENCH_SAVE_COMMAND,
    WORKBENCH_SAVE_AS_COMMAND,
    WORKBENCH_NEW_UNTITLED_FILE_COMMAND,
    WORKBENCH_REOPEN_CLOSED_EDITOR_COMMAND,
    WORKBENCH_SPLIT_EDITOR_COMMAND,
    ...WORKBENCH_FOCUS_EDITOR_GROUP_COMMANDS,
    ...WORKBENCH_RECENT_EDITOR_COMMANDS,
    TERMINAL_TOGGLE_COMMAND,
    TERMINAL_NEW_COMMAND,
    { id: TERMINAL_SPLIT_COMMAND_ID, ...terminalSplitDefaultHotkeys(platform), when: TERMINAL_SPLIT_WHEN },
    SHOW_COMMANDS_COMMAND,
    FOCUS_NEXT_PART_COMMAND,
    FOCUS_PREVIOUS_PART_COMMAND,
    ...TERMINAL_SCROLL_COMMANDS.map((c) => ({
      id: c.id,
      ...terminalScrollDefaultHotkeys(c, platform),
      when: TERMINAL_SCROLL_WHEN,
    })),
    ...TERMINAL_CLIPBOARD_COMMANDS.map((c) => ({ id: c.id, ...c.keys[os], when: c.when })),
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
  const commands = withDefaultCommands(registry.getAll(), TERMINAL_DEFAULTS[detectTerminalOs(platform)]);
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
 * 后退 / 前进(mac ⌃- / ⌃⇧-,Win/Linux Alt+← / Alt+→)、打开最近(⌃R 是 shell 的反向搜索历史)、切换自动换行(⌥Z)、
 * 切换窗口(mac ⌃W 是 shell 的删前一个词)。
 * 带 ⌘(Meta)的按键照常交给工作台(VSCode `event.metaKey` 一律跳过 shell)。id 与注册方一致(规范守护)。
 * BDD: src/__tests__/workbench-missing-commands/、src/__tests__/editor-navigation-history/
 */
export const TERMINAL_KEPT_COMMAND_IDS: ReadonlySet<string> = new Set([
  'workbench.action.navigateBack',
  'workbench.action.navigateForward',
  'workbench.action.openRecent',
  'editor.action.toggleWordWrap',
  // 切换窗口(mac ⌃W):⌃W 是 shell 的删前一个词;VSCode commandsToSkipShell 默认列表不含 switchWindow(BDD: src/__tests__/switch-window/)
  'workbench.action.switchWindow',
  // 按序号打开编辑器(⌃1…⌃9 / Alt+1…Alt+9;Alt+数字是 readline 的数字参数)、不带 Meta 的移动编辑器键(Windows / Linux Ctrl+Alt+← 等)
  // BDD: src/__tests__/editor-tab-management/
  ...WORKBENCH_OPEN_EDITOR_AT_INDEX_COMMAND_IDS,
  ...WORKBENCH_MOVE_EDITOR_COMMAND_IDS,
  // 复制路径 / 复制相对路径(Windows Shift+Alt+C、Linux Ctrl+Alt+C 照常进 shell;mac ⌥⌘C 带 ⌘ → 让出,复制活动文件路径)
  // BDD: src/__tests__/explorer-commands/
  'copyFilePath',
  'copyRelativeFilePath',
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

/**
 * mac 上没有被任何命令 / 行内编辑映射接走的 ⌘ + 功能键(Home / End / PageUp / PageDown / Delete / Insert / F1…F24 / Enter / Tab /
 * Escape / 方向键等非字符键):不交给 xterm。xterm 会把它们编码成带 Meta 修饰的序列(⌘Home = `ESC[1;9H`、⌘End = `ESC[1;9F`、
 * ⌘PageDown = `ESC[6~`、⌘Delete = `ESC[3;9~`、⌘F5 = `ESC[15;9~`)或照发 ⌘Enter = CR、⌘Tab = HT,shell 打出 `;9H` / `~` 乱码,
 * 全屏程序收到无意义按键。mac 终端(Terminal.app / iTerm2)⌘ 组合一律留给应用,不发给程序。
 * Continuo 偏离 VSCode:VSCode 只截住解析到命令的 ⌘ 键,未绑定的照常交给 xterm(会发出上述乱码)。
 * ⌘ + 字符键(⌘C / ⌘V / ⌘A …)xterm 本就不发字节,复制 / 粘贴 / 全选靠浏览器默认行为与 xterm 自身处理 → 不在此列。
 * 只让 xterm 跳过、不 preventDefault / 不截冒泡:全局分发与菜单加速键照常处理。
 */
export function isTerminalUnboundMetaKey(event: KeyboardEvent, platform: Platform = detectPlatform()): boolean {
  if (platform !== 'mac' || event.type !== 'keydown' || event.isComposing || !event.metaKey) return false;
  return event.key.length > 1 && event.key !== 'Meta';
}

/**
 * 转到文件 / 命令面板的开关键(Windows / Linux Ctrl+P / Ctrl+Shift+P,mac ⌘P / ⇧⌘P):VSCode commandsToSkipShell 默认列表含
 * workbench.action.quickOpen / showCommands → 终端获焦时不交给 xterm(Ctrl+P 不再发 ^P 给 shell),事件照常冒泡给 picker 的 document
 * 监听打开面板。有 Modal 开着时不让出(picker 监听同样不动)。BDD: src/__tests__/win-linux-parity/
 */
export function isTerminalPickerToggleKey(event: KeyboardEvent, platform: Platform = detectPlatform()): boolean {
  if (event.type !== 'keydown' || event.isComposing || isModalOpenFor(event)) return false;
  return isPickerToggleKey(event, platform === 'mac');
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

