// terminal-panel-handles — 每个 terminal panel 对外暴露的操作句柄,按 panelId 索引。
//
// TerminalPanelView 挂载时注册 { focus, openSearch },卸载时注销:
// - focus:topic-22 zoom toggle 用。dockview exit-maximize 后 setActive() 不会触发
//   xterm textarea focus(设计评审 P0-3),DockShell 订阅 onDidMaximizedGroupChange,
//   isMaximized=false 时显式调 focusTerminalPanel(group.activePanel.id) 拉回焦点。
// - openSearch:TerminalPlugin 的 terminal.search.toggle command 经 openTerminalSearch(panelId)
//   打开当前 active panel 的搜索条(Cmd+F)。
// - clear:terminal.clear command(⌘K)与终端右键菜单「清除」清空屏幕与滚动缓冲。
// - clipboard:终端复制 / 粘贴命令(Windows Ctrl+C 有选区 / Ctrl+V,Ctrl+Shift+C / Ctrl+Shift+V)。
// - scroll:终端滚动命令(⌘Home / ⌘End / PageUp …,见 terminal-hotkeys TERMINAL_SCROLL_COMMANDS)滚动视口。
// - readText:当前缓冲区文本(e2e 测试钩子读终端内容;WebGL 渲染时 DOM 里没有文字)。
// - readViewport:视口位置(e2e 测试钩子读滚动结果)。
//
// stale 安全:createCallbackRegistry 的 disposer 带 Symbol token,同 id 被新注册覆盖后旧
// disposer 不会误删新句柄;句柄内部用 termRef.current?.focus() 等 optional chain,
// useTerminal 卸载时已置 null。module-scope 单例 = 进程级单一 command bus。

import { createCallbackRegistry } from '@continuo-terminal/react-terminal';
import type { TerminalClipboardCommand, TerminalScrollAction } from './terminal-hotkeys';

/** 视口位置:viewportY = 视口首行在缓冲区的行号,baseY = 滚到底时的 viewportY;alternate = 备用屏激活。 */
export interface TerminalViewport {
  readonly viewportY: number;
  readonly baseY: number;
  readonly alternate: boolean;
}

export interface TerminalPanelHandles {
  readonly focus: () => void;
  readonly openSearch: () => void;
  readonly clear: () => void;
  readonly scroll: (action: TerminalScrollAction) => void;
  /** 复制选区 / 复制并清除选区 / 粘贴(终端复制 / 粘贴命令,见 terminal-hotkeys TERMINAL_CLIPBOARD_COMMANDS)。 */
  readonly clipboard: (action: TerminalClipboardCommand['action']) => void;
  readonly readText: () => string;
  readonly readViewport: () => TerminalViewport | null;
}

const handlesRegistry = createCallbackRegistry<TerminalPanelHandles>();

/** 注册 panel 句柄;同 id 再次注册覆盖旧值。返回 disposer(只删自己注册的那份)。 */
export function registerTerminalPanelHandles(
  panelId: string,
  handles: TerminalPanelHandles,
): () => void {
  return handlesRegistry.register(panelId, handles);
}

/** 已注册 → 调 focus 并返回 true;未注册 → false。 */
export function focusTerminalPanel(panelId: string): boolean {
  const handles = handlesRegistry.get(panelId);
  if (!handles) return false;
  handles.focus();
  return true;
}

/** 打开该 panel 的搜索条;未注册时 no-op。 */
export function openTerminalSearch(panelId: string): void {
  handlesRegistry.get(panelId)?.openSearch();
}

/** 清空该 panel 的屏幕与滚动缓冲;未注册时 no-op。 */
export function clearTerminalPanel(panelId: string): void {
  handlesRegistry.get(panelId)?.clear();
}

/** 按动作滚动该 panel 的视口;未注册时 no-op。 */
export function scrollTerminalPanel(panelId: string, action: TerminalScrollAction): void {
  handlesRegistry.get(panelId)?.scroll(action);
}

/** 对该 panel 执行复制 / 粘贴;未注册时 no-op。 */
export function runTerminalPanelClipboard(panelId: string, action: TerminalClipboardCommand['action']): void {
  handlesRegistry.get(panelId)?.clipboard(action);
}

/** 该 panel 的视口位置;未注册 → null。 */
export function readTerminalPanelViewport(panelId: string): TerminalViewport | null {
  return handlesRegistry.get(panelId)?.readViewport() ?? null;
}

/** 该 panel 当前缓冲区文本(每行去尾空白,\n 连接);未注册 → null。 */
export function readTerminalPanelText(panelId: string): string | null {
  return handlesRegistry.get(panelId)?.readText() ?? null;
}

// 测试用 — 重置全表(单测之间避免污染)。
export function __resetTerminalPanelHandlesForTest(): void {
  handlesRegistry.clear();
}
