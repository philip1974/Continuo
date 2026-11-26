// 维护 windowId → workspaceRoot 映射,供 main 端在 MCP agent
// terminal_create_session 无 cwd 入参时回退用。renderer 在 workspace.root 变化时
// 通过 window:notify-root IPC 推送。窗口关闭后自动清理。

import { isSameOrInsidePath } from '../lib/path-inside';

const map = new Map<number, string>();

/** path 是否等于任一窗口当前 workspace root(平台感知,双向包含 = 相等)。fs watcher LRU 据此钉住 root。 */
export function isAnyWorkspaceRoot(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  for (const root of map.values()) {
    if (isSameOrInsidePath(root, path, platform) && isSameOrInsidePath(path, root, platform)) return true;
  }
  return false;
}

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

/** 全部 windowId → root(只读迭代;「文件夹已在哪个窗口打开」判定用,见 workspace-window-lookup.service)。 */
export function workspaceRootEntries(): Iterable<readonly [number, string]> {
  return map.entries();
}

export function clearWindow(windowId: number): void {
  map.delete(windowId);
}

export function _reset(): void {
  map.clear();
}
