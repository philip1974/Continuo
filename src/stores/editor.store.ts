// M-Editor Step E1:编辑器全局 store。
// 从 MindAutonAgent 移植 + Jotai → Zustand 重写;沿用 ADR-007 vanilla 模式。
//
// 持久化由 Step E5+ 接入(目前内存态,Editor MVP 不接 explorer.json,
// session 恢复留下里程碑)。

import { create } from 'zustand';

// ── 类型 ─────────────────────────────────────────────────────

export type EditorMode = 'edit' | 'source' | 'preview';

export interface EditorTab {
  /** filePath 或 `untitled-${uuid}`. */
  readonly id: string;
  /** null = 未保存草稿. */
  readonly filePath: string | null;
  /** 当前内容(编辑器实时同步). */
  readonly content: string;
  /** 上次磁盘内容(dirty 比对依据). */
  readonly originalContent: string;
  /** = content !== originalContent. */
  readonly dirty: boolean;
}

// ── 纯函数 helpers(便于单测) ────────────────────────────────

export function createTab(
  filePath: string | null,
  content: string,
): EditorTab {
  return {
    id: filePath ?? `untitled-${crypto.randomUUID()}`,
    filePath,
    content,
    originalContent: content,
    dirty: false,
  };
}

export interface CloseTabResult {
  tabs: EditorTab[];
  activeTabId: string | null;
}

/**
 * 关闭 tab 后的新状态:
 * - 关不存在的 id → 状态不变
 * - 关非活跃 → tabs 减,active 不变
 * - 关活跃且后面有 → 切到下一个
 * - 关活跃且后面没 → 切到前一个
 * - 关最后一个 → active null
 */
export function getStateAfterClosingTab(
  tabs: EditorTab[],
  activeTabId: string | null,
  closingTabId: string,
): CloseTabResult {
  const idx = tabs.findIndex((t) => t.id === closingTabId);
  if (idx === -1) return { tabs, activeTabId };

  const remaining = tabs.filter((t) => t.id !== closingTabId);
  if (remaining.length === 0) return { tabs: remaining, activeTabId: null };
  if (closingTabId !== activeTabId) {
    return { tabs: remaining, activeTabId };
  }
  // 关的是活跃 tab:取原索引位的下一个,溢出则取前一个
  const nextIdx = Math.min(idx, remaining.length - 1);
  return {
    tabs: remaining,
    activeTabId: remaining[nextIdx]?.id ?? null,
  };
}

/**
 * 文件 / 目录被重命名 / 移动后的 tab 状态:
 * - 精确匹配 filePath === oldPath → 改 id+filePath 为 newPath
 * - 子文件(`oldPath/` 或 `oldPath\\` 前缀)→ 前缀 rewrite
 * - untitled(filePath=null)tab 不受影响
 * - dirty / content / originalContent 全部保留
 * - activeTabId 跟随目标 tab id 改变
 */
export function getStateAfterRenamingPath(
  tabs: EditorTab[],
  activeTabId: string | null,
  oldPath: string,
  newPath: string,
): CloseTabResult {
  const rewrite = (filePath: string): string | null => {
    if (filePath === oldPath) return newPath;
    if (filePath.startsWith(oldPath + '/')) {
      return newPath + filePath.slice(oldPath.length);
    }
    if (filePath.startsWith(oldPath + '\\')) {
      return newPath + filePath.slice(oldPath.length);
    }
    return null;
  };

  let changed = false;
  const newTabs = tabs.map((t) => {
    if (t.filePath === null) return t;
    const np = rewrite(t.filePath);
    if (np === null) return t;
    changed = true;
    return { ...t, id: np, filePath: np };
  });
  if (!changed) return { tabs, activeTabId };

  let nextActive = activeTabId;
  if (activeTabId !== null) {
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    if (idx >= 0) nextActive = newTabs[idx]!.id;
  }
  return { tabs: newTabs, activeTabId: nextActive };
}

/**
 * 文件 / 目录被删除后的 tab 状态:
 * - 精确匹配 filePath === removedPath
 * - 或位于该目录下(`removedPath/` 或 `removedPath\\` 前缀)
 * - untitled(filePath=null)tab 不受影响
 * - 同前缀但非子(如 `/x/foo` 删 vs `/x/foobar.md`)不误关
 * - active 被关 → 取原序后向第一个 remaining,否则前一个,否则 null
 */
export function getStateAfterRemovingPath(
  tabs: EditorTab[],
  activeTabId: string | null,
  removedPath: string,
): CloseTabResult {
  const isMatch = (filePath: string | null): boolean => {
    if (filePath === null) return false;
    if (filePath === removedPath) return true;
    return (
      filePath.startsWith(removedPath + '/') ||
      filePath.startsWith(removedPath + '\\')
    );
  };

  const removingIds = new Set<string>();
  for (const t of tabs) if (isMatch(t.filePath)) removingIds.add(t.id);
  if (removingIds.size === 0) return { tabs, activeTabId };

  const remaining = tabs.filter((t) => !removingIds.has(t.id));
  if (remaining.length === 0) return { tabs: remaining, activeTabId: null };
  if (activeTabId === null || !removingIds.has(activeTabId)) {
    return { tabs: remaining, activeTabId };
  }
  const oldIdx = tabs.findIndex((t) => t.id === activeTabId);
  let next: EditorTab | null = null;
  for (let i = oldIdx + 1; i < tabs.length; i++) {
    if (!removingIds.has(tabs[i]!.id)) {
      next = tabs[i]!;
      break;
    }
  }
  if (!next) {
    for (let i = oldIdx - 1; i >= 0; i--) {
      if (!removingIds.has(tabs[i]!.id)) {
        next = tabs[i]!;
        break;
      }
    }
  }
  return { tabs: remaining, activeTabId: next?.id ?? null };
}

// ── Zustand store ────────────────────────────────────────────

type EditorState = {
  tabs: EditorTab[];
  activeTabId: string | null;
  mode: EditorMode;

  /** 已存在则切换 active,新加则推入. */
  openTab: (tab: EditorTab) => void;
  closeTab: (id: string) => void;
  /** 文件/目录被删除时调用:精确匹配或前缀匹配的 tab 统一关闭. */
  removePath: (path: string) => void;
  /** 文件/目录被重命名 / 移动时调用:精确或前缀匹配的 tab 同步路径. */
  renamePath: (oldPath: string, newPath: string) => void;
  switchTab: (id: string) => void;
  /** 编辑器 onChange 时调用;dirty 自动比对. */
  updateContent: (id: string, content: string) => void;
  /** 保存成功后调用:originalContent ← content,dirty=false. */
  markSaved: (id: string) => void;
  /** 另存为后:把 tab 的 filePath 与 id 同步改为 newPath. */
  setFilePath: (id: string, newPath: string) => void;
  setMode: (mode: EditorMode) => void;
};

export const useEditorStore = create<EditorState>((set) => ({
  tabs: [],
  activeTabId: null,
  mode: 'edit',

  openTab: (tab) =>
    set((s) => {
      const exists = s.tabs.some((t) => t.id === tab.id);
      if (exists) return { activeTabId: tab.id };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    }),

  closeTab: (id) =>
    set((s) => getStateAfterClosingTab(s.tabs, s.activeTabId, id)),

  removePath: (path) =>
    set((s) => getStateAfterRemovingPath(s.tabs, s.activeTabId, path)),

  renamePath: (oldPath, newPath) =>
    set((s) =>
      getStateAfterRenamingPath(s.tabs, s.activeTabId, oldPath, newPath),
    ),

  switchTab: (id) => set(() => ({ activeTabId: id })),

  updateContent: (id, content) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      const next: EditorTab = {
        ...cur,
        content,
        dirty: content !== cur.originalContent,
      };
      const tabs = s.tabs.slice();
      tabs[idx] = next;
      return { tabs };
    }),

  markSaved: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      const next: EditorTab = {
        ...cur,
        originalContent: cur.content,
        dirty: false,
      };
      const tabs = s.tabs.slice();
      tabs[idx] = next;
      return { tabs };
    }),

  setFilePath: (id, newPath) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      const next: EditorTab = { ...cur, id: newPath, filePath: newPath };
      const tabs = s.tabs.slice();
      tabs[idx] = next;
      return {
        tabs,
        activeTabId: s.activeTabId === id ? newPath : s.activeTabId,
      };
    }),

  setMode: (mode) => set(() => ({ mode })),
}));
