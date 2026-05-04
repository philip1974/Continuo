import { create } from 'zustand';

export type ExplorerSortBy = 'name' | 'mtime' | 'ctime' | 'size';
export interface ExplorerSort {
  by: ExplorerSortBy;
  reverse: boolean;
}

type ExplorerState = {
  /** 焦点(箭头键导航锚点 + 单击单选). */
  activePath: string | null;
  /** 多选集合(批量操作目标). */
  selectedPaths: ReadonlySet<string>;
  /** Shift+click 范围选的另一端;不持久化. */
  lastAnchorPath: string | null;
  /** 树展开状态(持久化). */
  expandedPaths: ReadonlySet<string>;
  /** 排序配置(持久化). */
  sort: ExplorerSort;
  /** 当前搜索串(不持久化). */
  search: string;

  toggleExpand: (path: string) => void;
  selectSingle: (path: string) => void;
  selectToggle: (path: string) => void;
  selectRange: (path: string, flat: readonly string[]) => void;
  clearSelection: () => void;
  setSort: (sort: ExplorerSort) => void;
  setSearch: (s: string) => void;
};

export const useExplorerStore = create<ExplorerState>((set) => ({
  activePath: null,
  selectedPaths: new Set(),
  lastAnchorPath: null,
  expandedPaths: new Set(),
  sort: { by: 'name', reverse: false },
  search: '',

  toggleExpand: (path) =>
    set((s) => {
      const next = new Set(s.expandedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedPaths: next };
    }),

  selectSingle: (path) =>
    set(() => ({
      selectedPaths: new Set([path]),
      activePath: path,
      lastAnchorPath: path,
    })),

  selectToggle: (path) =>
    set((s) => {
      const next = new Set(s.selectedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return {
        selectedPaths: next,
        activePath: path,
        lastAnchorPath: path,
      };
    }),

  selectRange: (path, flat) =>
    set((s) => {
      const anchor = s.lastAnchorPath;
      const anchorIdx = anchor === null ? -1 : flat.indexOf(anchor);
      const targetIdx = flat.indexOf(path);
      // 任一端缺失 → 退化为 selectSingle
      if (anchorIdx < 0 || targetIdx < 0) {
        return {
          selectedPaths: new Set([path]),
          activePath: path,
          lastAnchorPath: path,
        };
      }
      const lo = Math.min(anchorIdx, targetIdx);
      const hi = Math.max(anchorIdx, targetIdx);
      const next = new Set(flat.slice(lo, hi + 1));
      return {
        selectedPaths: next,
        activePath: path,
        // anchor 不动(VSCode 行为)
      };
    }),

  clearSelection: () => set(() => ({ selectedPaths: new Set() })),

  setSort: (sort) => set(() => ({ sort })),
  setSearch: (search) => set(() => ({ search })),
}));
