// terminal-focus-registry — topic-22 zoom toggle 用。
//
// dockview exit-maximize 后 setActive() 不会触发 xterm textarea focus
// (codex red-team v1 P0-3 戳穿)。注册表把每个 terminal panel 的 focus()
// callback 按 panelId 索引,DockShell 订阅 onDidMaximizedGroupChange
// isMaximized=false 时显式调 focusTerminalPanel(group.activePanel.id) 拉回焦点。
//
// stale 安全:callback 内部用 termRef.current?.focus() optional chain
// (useTerminal 在 unmount 时已 termRef.current = null)。
//
// topic 25: 改用 `@continuo-terminal/react-terminal` 的 createCallbackRegistry
// factory（Symbol token stale-safe disposer）；module-scope 实例化保留进程级
// single command bus 行为；API 签名不变（DockShell + TerminalPanelView 不需改）。

import { createCallbackRegistry } from '@continuo-terminal/react-terminal';

const focusRegistry = createCallbackRegistry<() => void>();

export function registerTerminalFocus(
  panelId: string,
  fn: () => void,
): () => void {
  return focusRegistry.register(panelId, fn);
}

export function focusTerminalPanel(panelId: string): boolean {
  const fn = focusRegistry.get(panelId);
  if (!fn) return false;
  fn();
  return true;
}

// 测试用 — 重置全表(单测之间避免污染)。生产代码不导出此符号。
export function __resetTerminalFocusRegistryForTest(): void {
  focusRegistry.clear();
}
