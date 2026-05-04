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

// ── Zustand store ────────────────────────────────────────────

type EditorState = {
  tabs: EditorTab[];
  activeTabId: string | null;
  mode: EditorMode;

  /** 已存在则切换 active,新加则推入. */
  openTab: (tab: EditorTab) => void;
  closeTab: (id: string) => void;
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
