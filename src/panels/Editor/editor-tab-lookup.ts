import { pathEquals } from '@/lib/path-cross';
import type { EditorTab } from '@/stores/editor.store';

export function findEditorFileTabByPath(
  tabs: readonly EditorTab[],
  path: string,
): EditorTab | null {
  for (const tab of tabs) {
    if (pathEquals(tab.filePath, path)) return tab;
  }
  return null;
}

/**
 * tab 是否对应磁盘路径 p:比较打开拼写 filePath 或读盘解析出的 realPath(symlink / 经 /tmp → /private/tmp 等
 * 非 canonical 路径打开时两者不同,外部来源如 watcher / debug adapter 报的可能是任一侧)。
 */
export function tabMatchesDiskPath(
  tab: Pick<EditorTab, 'filePath' | 'realPath'>,
  p: string,
): boolean {
  return (
    pathEquals(tab.filePath, p) ||
    (tab.realPath !== undefined && pathEquals(tab.realPath, p))
  );
}

/** 按 id 找 tab;id 为 null(无 active tab)→ null。 */
export function findEditorFileTabById(
  tabs: readonly EditorTab[],
  tabId: string | null,
): EditorTab | null {
  if (tabId === null) return null;
  for (const tab of tabs) {
    if (tab.id === tabId) return tab;
  }
  return null;
}
