// 维护 windowId → workspaceRoot 映射,供 main 端在 MCP agent
// terminal_create_session 无 cwd 入参时回退用。renderer 在 workspace.root 变化时
// 通过 window:notify-root IPC 推送。窗口关闭后自动清理。

const map = new Map<number, string>();

export function setWorkspaceRoot(windowId: number, root: string | null): void {
  if (root === null) {
    map.delete(windowId);
    return;
  }
  map.set(windowId, root);
}

export function getWorkspaceRoot(windowId: number): string | null {
  return map.get(windowId) ?? null;
}

export function clearWindow(windowId: number): void {
  map.delete(windowId);
}

export function _reset(): void {
  map.clear();
}
