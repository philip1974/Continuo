// Quick Open 状态(VSCode ⌘P 同款)。Zustand vanilla。
//
// 与 CommandPalette store 区别:
// - 加 results: 文件列表(walk 异步加载,close 后保留供下次 reopen)
// - 加 loading: walk 期间 spinner

import { create } from 'zustand';

export interface QuickOpenFile {
  /** 绝对路径(用于 openFileByPath). */
  readonly absPath: string;
  /** 相对 rootPath 的展示路径(列表灰色辅助文字). */
  readonly relPath: string;
  /** basename(列表主标题). */
  readonly name: string;
}

interface QuickOpenState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  results: readonly QuickOpenFile[];
  loading: boolean;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  moveSelection: (delta: number, max: number) => void;
  setResults: (files: readonly QuickOpenFile[]) => void;
  setLoading: (b: boolean) => void;
}

export const useQuickOpenStore = create<QuickOpenState>((set) => ({
  isOpen: false,
  query: '',
  selectedIndex: 0,
  results: [],
  loading: false,

  open: () => set({ isOpen: true, query: '', selectedIndex: 0 }),
  // 不清 results / query — 用户秒级再开还能看到上次的列表。
  // 真要 reset 在 walk 完成后才 setResults。
  close: () => set({ isOpen: false }),
  setQuery: (q) => set({ query: q, selectedIndex: 0 }),
  moveSelection: (delta, max) =>
    set((s) => {
      if (max <= 0) return { selectedIndex: 0 };
      const next = (s.selectedIndex + delta + max) % max;
      return { selectedIndex: next };
    }),
  setResults: (files) => set({ results: files }),
  setLoading: (b) => set({ loading: b }),
}));
