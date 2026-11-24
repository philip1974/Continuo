// 终端「让出给命令」的热键(终端拦下该键、不交给 xterm / PTY):命令注册(TerminalPlugin)与终端判定(useTerminal)
// 同一来源,且按**实际生效绑定**判(resolveActiveHotkey:用户改绑 → 跟随新键;解绑或落在 ⌘P / ⌘⇧P 保留键 → 不再让出,
// 按键照常进 shell / 交给 picker)。
// 此前缩放用兄弟包 shouldSkipXtermKey(不分平台)、搜索用 isSearchHotkey(固定 mod+f),均不读改绑:mac 上
// Shift+Ctrl+Enter、改绑 / 解绑后的原默认键被拦下不发给 shell、命令又不匹配,按键被吞。
import { matchesHotkey } from '@/plugins/command-palette/useCommandHotkeys';
import { detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { resolveActiveHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { coApp } from '@/plugins/co-app';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import { tWithFallback } from '@/i18n';

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
 * - terminal.clear 在 commandsToSkipShell 默认列表里 → 匹配生效绑定即让出;
 * - 关闭编辑器 / 保存不在列表里 → 只有按键带 Meta(mac ⌘)才让出。Win/Linux 上 Ctrl+W(删前一词)/ Ctrl+S
 *  (XOFF)照常进 shell,与 VSCode 一致。
 */
const SKIP_SHELL_COMMANDS: readonly {
  readonly id: string;
  readonly defaultHotkey: (platform: Platform) => string | undefined;
  readonly metaOnly: boolean;
}[] = [
  { id: TERMINAL_CLEAR_COMMAND.id, defaultHotkey: terminalClearDefaultHotkey, metaOnly: false },
  { id: WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND.id, defaultHotkey: () => WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND.hotkey, metaOnly: true },
  { id: WORKBENCH_SAVE_COMMAND.id, defaultHotkey: () => WORKBENCH_SAVE_COMMAND.hotkey, metaOnly: true },
];

interface CommandLookup {
  get(id: string): { readonly id: string; readonly hotkey?: string } | undefined;
}

type Overrides = Readonly<Record<string, string>>;

function matchesEffective(
  command: { readonly id: string; readonly hotkey?: string },
  event: KeyboardEvent,
  platform: Platform,
  overrides: Overrides,
): boolean {
  if (event.type !== 'keydown' || event.isComposing) return false;
  const combo = resolveActiveHotkey(command, overrides, platform); // 保留键上的绑定不让出(与命令分发同判)
  return combo !== undefined && matchesHotkey(combo, event, platform);
}

/** 终端应让出给缩放命令的按键。 */
export function isTerminalZoomHotkey(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
  overrides: Overrides = useKeybindingsStore.getState().overrides,
): boolean {
  return matchesEffective(TERMINAL_ZOOM_COMMAND, event, platform, overrides);
}

/** 终端应拦下并打开搜索条的按键。 */
export function isTerminalSearchHotkey(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
  overrides: Overrides = useKeybindingsStore.getState().overrides,
): boolean {
  return matchesEffective(TERMINAL_SEARCH_COMMAND, event, platform, overrides);
}

/**
 * 终端应让出给工作台命令(clear / closeActiveEditor / save)的按键 → 命令 id;否则 null。
 * 默认键:命令已注册取注册的 hotkey(注册方改默认键也跟随),未注册取约定默认键;再叠加用户改绑 / 解绑。
 * 关闭 / 保存另须按键带 Meta(见 SKIP_SHELL_COMMANDS)。
 */
export function terminalYieldedCommandId(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
  overrides: Overrides = useKeybindingsStore.getState().overrides,
  registry: CommandLookup = coApp.commands,
): string | null {
  for (const command of SKIP_SHELL_COMMANDS) {
    if (command.metaOnly && !event.metaKey) continue;
    const live = registry.get(command.id);
    const spec = { id: command.id, hotkey: live ? live.hotkey : command.defaultHotkey(platform) };
    if (matchesEffective(spec, event, platform, overrides)) return command.id;
  }
  return null;
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

/** 键盘打开终端右键菜单:Shift+F10 / 菜单键(Windows / Linux 约定,mac 上同样可用)。 */
export function isTerminalContextMenuKey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.isComposing) return false;
  if (event.key === 'ContextMenu') return true;
  return event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
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

