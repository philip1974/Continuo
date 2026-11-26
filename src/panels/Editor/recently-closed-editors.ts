// 最近关闭的编辑器栈(每窗口一份,只在会话内存):供 workbench.action.reopenClosedEditor(⇧⌘T)重新打开。
// 对齐 VSCode HistoryService.recentlyClosedEditors:最多 20 条,同一路径再次关闭先移除旧条目再入栈顶。
// 入栈 / 失效由 editor.store 调用(closeTab / removeGroup / removePaths / closeTabsOutsideRoot);本模块不 import store。
// BDD: src/__tests__/editor-reopen-closed/

import type { PersistedEditorViewState } from './editor-view-state-cache';

export const RECENTLY_CLOSED_EDITORS_MAX = 20;

export interface RecentlyClosedEditor {
  /** tab id(= 打开时的路径拼写)。 */
  readonly path: string;
  /** 关闭时所在的编辑器组 id。 */
  readonly groupId: string;
  /** 关闭时在组内的位置。 */
  readonly index: number;
  /** 关闭前的视图状态摘要(与跨重启恢复同一形态);无 → undefined。 */
  readonly viewState: PersistedEditorViewState | undefined;
}

let stack: RecentlyClosedEditor[] = [];

export function pushRecentlyClosedEditor(entry: RecentlyClosedEditor): void {
  stack = stack.filter((e) => e.path !== entry.path);
  stack.push(entry);
  if (stack.length > RECENTLY_CLOSED_EDITORS_MAX) stack.shift();
}

/** 取出栈顶;栈空 → undefined。 */
export function popRecentlyClosedEditor(): RecentlyClosedEditor | undefined {
  return stack.pop();
}

/** 移除 isGone(path) 为真的条目(文件被删除 / 切换工作区根)。 */
export function dropRecentlyClosedEditors(isGone: (path: string) => boolean): void {
  if (stack.length > 0) stack = stack.filter((e) => !isGone(e.path));
}

/** 当前栈里的路径(栈底在前)。 */
export function recentlyClosedEditorPaths(): string[] {
  return stack.map((e) => e.path);
}

/** 测试用:清空。 */
export function clearRecentlyClosedEditors(): void {
  stack = [];
}
