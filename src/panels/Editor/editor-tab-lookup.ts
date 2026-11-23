import { pathEquals } from '@/lib/path-cross';
import type { EditorTab } from '@/stores/editor.store';

export function findEditorFileTabByPath(
  tabs: readonly EditorTab[],
  path: string,
): EditorTab | null {
  for (const tab of tabs) {
    if (pathEquals(tab.filePath ?? tab.id, path)) return tab;
  }
  return null;
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
