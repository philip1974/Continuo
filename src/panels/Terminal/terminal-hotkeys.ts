// 终端「让出给命令」的热键(终端拦下该键、不交给 xterm / PTY):命令注册(TerminalPlugin)与终端判定(useTerminal)
// 同一来源,且按**生效绑定**判(resolveEffectiveHotkey:用户改绑 → 跟随新键;解绑 → 不再让出,按键照常进 shell)。
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

type Overrides = Readonly<Record<string, string>>;

function matchesEffective(
  command: { readonly id: string; readonly hotkey: string },
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
 * 终端判中缩放键时**直接执行**缩放命令并截住事件,不依赖冒泡到 document 的全局热键分发:后者对「事件来自可编辑控件
 *(xterm 的 helper textarea)且绑定无 ctrl/meta/alt」的组合一律放行(A64)—— 用户把缩放改绑为 F2 / Shift+Enter 时,
 * 终端让出、全局分发又跳过,按键被吞。截住冒泡也避免带修饰键的绑定被两条路径各执行一次。
 */
export function runTerminalZoomFromKey(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  runRegisteredCommand(coApp.commands, TERMINAL_ZOOM_COMMAND.id, tWithFallback('commands.terminal.zoom.title', 'Toggle Terminal Zoom'));
}

