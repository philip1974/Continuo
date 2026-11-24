import { create } from 'zustand';
import { isSameOrInsidePath } from '@/lib/path-cross';
import { pruneClipboardPaths } from '@/panels/Explorer/clipboard-store';
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

  setExpandedPaths: (paths: Iterable<string>) => void;
  /** 路径已移走(改名 / 移动):旧路径及其后代前缀替换为新路径,保留展开状态。 */
  renameExpanded: (oldPath: string, newPath: string) => void;
  /** 路径已删除:移除这些路径及其后代的展开状态。 */
  forgetExpanded: (removedPaths: readonly string[]) => void;
  setSort: (sort: ExplorerSort) => void;
};

const EMPTY_EXPANDED_PATHS: ReadonlySet<string> = new Set();

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  expandedPaths: EMPTY_EXPANDED_PATHS,
  sort: { by: 'name', reverse: false },

  setExpandedPaths: (paths) =>
    set((s) => {
      if (paths === s.expandedPaths) return s;
      // 边界(E277,运行时状态守持久化契约):expand 不得超持久化 schema(数量 ≤ PATH_ARRAY_MAX,单条 path ≤
      // PATH_STR_MAX),否则 snapshotFromStores 写出后 explorer:write 被拒整份 → 全 explorer 持久化失败。
      // 数量截断到 PATH_ARRAY_MAX,过滤超长 path。
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

  // 包含判断与前缀切片同 editor.store getStateAfterRenamingPath(isSameOrInsidePath:分隔符无关 +
  // 平台感知大小写;大小写折叠不改长度,故按 oldPath.length 切片)。无命中 → 不写 store。
  renameExpanded: (oldPath, newPath) => {
    const next = renameInExpanded(get().expandedPaths, oldPath, newPath);
    if (next !== null) get().setExpandedPaths(next);
  },

  forgetExpanded: (removedPaths) => {
    const next = forgetInExpanded([...get().expandedPaths], removedPaths);
    if (next !== null) get().setExpandedPaths(next);
  },

  setSort: (sort) =>
    set((s) =>
      s.sort.by === sort.by && s.sort.reverse === sort.reverse
        ? s
        : { sort },
    ),
}));

/**
 * 展开集合里 oldPath 及其后代改写为 newPath 前缀;无命中 → null。store 的 renameExpanded 与 Explorer「全部展开」
 * 批量期暂存的数组(批末整体写回,须同样改写,否则覆盖掉批量期间的改名)共用。
 */
export function renameInExpanded(
  paths: Iterable<string>,
  oldPath: string,
  newPath: string,
): string[] | null {
  let changed = false;
  const next: string[] = [];
  for (const p of paths) {
    if (isSameOrInsidePath(oldPath, p)) {
      changed = true;
      next.push(newPath + p.slice(oldPath.length));
    } else {
      next.push(p);
    }
  }
  return changed ? next : null;
}

/** 移除 removedPaths 及其后代(与剪贴板 prune 同一实现,祖先索引);无命中 → null。用途同 renameInExpanded。 */
export function forgetInExpanded(
  paths: readonly string[],
  removedPaths: readonly string[],
): string[] | null {
  if (removedPaths.length === 0) return null;
  const remaining = pruneClipboardPaths(paths, removedPaths);
  return remaining === paths ? null : [...remaining];
}

