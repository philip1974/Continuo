import { create } from 'zustand';
import {
  PATH_ARRAY_MAX,
  PATH_STR_MAX,
} from '../../electron/shared/explorer-persistence-schema';

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

const EMPTY_EXPANDED_PATHS: ReadonlySet<string> = new Set();

export const useExplorerStore = create<ExplorerState>((set) => ({
  expandedPaths: EMPTY_EXPANDED_PATHS,
  sort: { by: 'name', reverse: false },

  toggleExpand: (path) =>
    set((s) => {
      const has = s.expandedPaths.has(path);
      // 边界(E277,E276 同族 / 运行时状态守持久化契约):expand 不得超持久化 schema(数量 ≤ PATH_ARRAY_MAX,
      // 单条 path ≤ PATH_STR_MAX),否则 snapshotFromStores 写出后 explorer:write 被拒整份 → 全 explorer 持久化失败。
      if (!has && (s.expandedPaths.size >= PATH_ARRAY_MAX || path.length > PATH_STR_MAX)) {
        return s;
      }
      const next = new Set(s.expandedPaths);
      if (has) {
        next.delete(path);
        return { expandedPaths: next.size === 0 ? EMPTY_EXPANDED_PATHS : next };
      }
      next.add(path);
      return { expandedPaths: next };
    }),

  setExpandedPaths: (paths) =>
    set((s) => {
      if (paths === s.expandedPaths) return s;
      // 边界(E277):批量设置也按持久化契约约束 —— 数量截断到 PATH_ARRAY_MAX,过滤超长 path。
      const next = new Set<string>();
      for (const p of paths) {
        if (next.size >= PATH_ARRAY_MAX) break;
        if (p.length <= PATH_STR_MAX) next.add(p);
      }
      if (next.size === s.expandedPaths.size) {
        let same = true;
        for (const p of next) {
          if (!s.expandedPaths.has(p)) {
            same = false;
            break;
          }
        }
        if (same) return s;
      }
      return { expandedPaths: next.size === 0 ? EMPTY_EXPANDED_PATHS : next };
    }),

  setSort: (sort) =>
    set((s) =>
      s.sort.by === sort.by && s.sort.reverse === sort.reverse
        ? s
        : { sort },
    ),
}));
