// terminal-search-registry — Cmd+F open-search callback registry。
//
// TerminalPanelView 注册每 panel 的 open() callback；TerminalPlugin 的
// terminal.search.toggle command 通过 openTerminalSearch(panelId) 触发当前
// active panel 的 search bar。
//
// topic 25: 改用 `@continuo-terminal/react-terminal` 的 createCallbackRegistry
// factory（Symbol token stale-safe disposer）；module-scope 实例化保留进程级
// single command bus 行为；API 不一致形态（{dispose} 对象 + unregister 独立函数）
// 保留历史（避免改 consumer）。

import { createCallbackRegistry } from '@continuo-terminal/react-terminal';

const searchRegistry = createCallbackRegistry<() => void>();

export function registerTerminalSearch(
  panelId: string,
  openFn: () => void,
): { dispose: () => void } {
  const dispose = searchRegistry.register(panelId, openFn);
  return { dispose };
}

export function openTerminalSearch(panelId: string): boolean {
  const openFn = searchRegistry.get(panelId);
  if (!openFn) return false;
  openFn();
  return true;
}

export function unregisterTerminalSearch(panelId: string): void {
  searchRegistry.unregister(panelId);
}

export function __resetTerminalSearchRegistryForTest(): void {
  searchRegistry.clear();
}
