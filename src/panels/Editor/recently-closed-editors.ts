// 最近关闭的编辑器栈(每窗口一份,只在会话内存):供 workbench.action.reopenClosedEditor(⇧⌘T)重新打开。
// 对齐 VSCode HistoryService.recentlyClosedEditors:最多 20 条,同一路径再次关闭先移除旧条目再入栈顶。
// 入栈 / 失效 / 改写由 editor.store 调用(closeTab / removeGroup / removePaths / renamePath / closeTabsOutsideRoot);
// 本模块不 import store。改名 / 移动:条目路径同前缀改写(VSCode 不改写、靠 watcher 的删除事件移除旧条目;
// 改写后 ⇧⌘T 仍能打开移走的文件,比静默丢失更有用,且成本只是一次映射)。
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

/** 改名 / 移动:rewrite(path) 非 null 的条目改为新路径(顺序不变;与已有条目重复时保留更近关闭的那条)。 */
export function rewriteRecentlyClosedEditors(rewrite: (path: string) => string | null): void {
  if (stack.length === 0) return;
  let changed = false;
  const mapped = stack.map((e) => {
    const next = rewrite(e.path);
    if (next === null || next === e.path) return e;
    changed = true;
    return { ...e, path: next };
  });
  if (!changed) return;
  const seen = new Set<string>();
  const out: RecentlyClosedEditor[] = [];
  for (let i = mapped.length - 1; i >= 0; i--) {
    const e = mapped[i]!;
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    out.push(e);
  }
  stack = out.reverse();
}

/** 当前栈里的路径(栈底在前)。 */
export function recentlyClosedEditorPaths(): string[] {
  return stack.map((e) => e.path);
}

/** 测试用:清空。 */
export function clearRecentlyClosedEditors(): void {
  stack = [];
}
