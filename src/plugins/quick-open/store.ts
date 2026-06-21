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
  /**
   * 性能 P16:relPath.toLowerCase() 预计算(scan 时一次)。fuzzyFilter 用它做大小写
   * 不敏感匹配,避免每按键对全部候选重复 lowercasing。relPath 在一次 scan 内稳定。
   */
  readonly relPathLower: string;
  /** basename(列表主标题). */
  readonly name: string;
}

interface QuickOpenState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  results: readonly QuickOpenFile[];
  loading: boolean;
  /** walk 失败标志 —— 与"workspace 真为空"区分,避免静默失败伪装成空列表。 */
  scanFailed: boolean;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  moveSelection: (delta: number, max: number) => void;
  setResults: (files: readonly QuickOpenFile[]) => void;
  setLoading: (b: boolean) => void;
  setScanFailed: (b: boolean) => void;
}

export const useQuickOpenStore = create<QuickOpenState>((set) => ({
  isOpen: false,
  query: '',
  selectedIndex: 0,
  results: [],
  loading: false,
  scanFailed: false,

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
  setScanFailed: (b) => set({ scanFailed: b }),
}));
