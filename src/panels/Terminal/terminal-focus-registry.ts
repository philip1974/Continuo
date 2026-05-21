// terminal-focus-registry — topic-22 zoom toggle 用。
//
// dockview exit-maximize 后 setActive() 不会触发 xterm textarea focus
// (codex red-team v1 P0-3 戳穿)。注册表把每个 terminal panel 的 focus()
// callback 按 panelId 索引,DockShell 订阅 onDidMaximizedGroupChange
// isMaximized=false 时显式调 focusTerminalPanel(group.activePanel.id) 拉回焦点。
//
// stale 安全:callback 内部用 termRef.current?.focus() optional chain
// (useTerminal 在 unmount 时已 termRef.current = null)。

const focusFns = new Map<string, () => void>();

export function registerTerminalFocus(
  panelId: string,
  fn: () => void,
): () => void {
  focusFns.set(panelId, fn);
  return () => {
    focusFns.delete(panelId);
  };
}

export function focusTerminalPanel(panelId: string): boolean {
  const fn = focusFns.get(panelId);
  if (!fn) return false;
  fn();
  return true;
}

// 测试用 — 重置全表(单测之间避免污染)。生产代码不导出此符号。
export function __resetTerminalFocusRegistryForTest(): void {
  focusFns.clear();
}
