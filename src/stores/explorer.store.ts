import { create } from 'zustand';

export type ExplorerSortBy = 'name' | 'mtime' | 'ctime' | 'size';
export interface ExplorerSort {
  by: ExplorerSortBy;
  reverse: boolean;
}

type ExplorerState = {
  /** 焦点(箭头键导航锚点 + 单击单选). */
  activePath: string | null;
  /** 树展开状态(持久化). */
  expandedPaths: ReadonlySet<string>;
  /** 排序配置(持久化). */
  sort: ExplorerSort;
  /** 当前搜索串(不持久化). */
  search: string;

  toggleExpand: (path: string) => void;
  setExpandedPaths: (paths: Iterable<string>) => void;
  setSort: (sort: ExplorerSort) => void;
  setSearch: (s: string) => void;
};

export const useExplorerStore = create<ExplorerState>((set) => ({
  activePath: null,
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

  setExpandedPaths: (paths) =>
    set(() => ({ expandedPaths: new Set(paths) })),

  setSort: (sort) => set(() => ({ sort })),
  setSearch: (search) => set(() => ({ search })),
}));
