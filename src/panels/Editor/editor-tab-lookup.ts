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

export function findEditorFileTabById(
  tabs: readonly EditorTab[],
  tabId: string,
): EditorTab | null {
  for (const tab of tabs) {
    if (tab.id === tabId) return tab;
  }
  return null;
}
