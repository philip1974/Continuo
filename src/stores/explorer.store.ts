import { create } from 'zustand';

export type ExplorerSortBy = 'name' | 'mtime' | 'ctime' | 'size';
export interface ExplorerSort {
  by: ExplorerSortBy;
  reverse: boolean;
}

type ExplorerState = {
  // 注:Explorer 焦点 / 单选锚点现由 headless-tree 的 selection state 持有,
  // 不在本 store。曾有的 `activePath`(打磨 R18)与 `search`/`setSearch`(打磨 R19)
  // 都是从无生产 setter/reader 的死字段,已删;等真正实现 Explorer 搜索 UI 时再按
  // 实际交互重新引入 search。文件级"活跃 tab 恢复"由 editor.activePath 负责。
  /** 树展开状态(持久化). */
  expandedPaths: ReadonlySet<string>;
  /**
   * 排序配置(持久化)。**Reserved scaffolding**:FolderTree/tree-config 目前
   * 直接用 fs.listDir 的顺序,尚未按 sort 排序,Header 也无排序 UI(打磨 R20:
   * 已确认未接线)。与已删的 activePath/search 不同 —— sort 是唯一、强类型
   * (ExplorerSortBy 全枚举)、已持久化的用户偏好,无替代实现,是为「Explorer
   * 排序」功能预留的脚手架,故保留 store 字段 + 持久化通路 ready;接 Explorer
   * 排序 UI 时把 sort 接到 getChildrenWithData 的 children 排序即可。
   */
  sort: ExplorerSort;

  toggleExpand: (path: string) => void;
  setExpandedPaths: (paths: Iterable<string>) => void;
  setSort: (sort: ExplorerSort) => void;
};

export const useExplorerStore = create<ExplorerState>((set) => ({
  expandedPaths: new Set(),
  sort: { by: 'name', reverse: false },

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
}));
