// 侧栏「大纲」视图状态(VSCode outline 视图:分区展开 / 跟随光标 / 排序方式跨重启保留;折叠的节、过滤词、键盘活动行只在本次运行)。
// 视图偏好存 localStorage(同设置 / 快捷键的轻量策略;读坏值按默认)。BDD: src/__tests__/markdown-outline/

import { create } from 'zustand';
import { readStoredJson, writeRecord } from '@/plugins/storage/local-storage-record';
import { clampSearchQuery } from '@/lib/search-query';
import type { OutlineSortBy } from './outline-model';

export const OUTLINE_PREFS_KEY = 'continuo.outline.prefs';

interface OutlinePrefs {
  /** 侧栏里「大纲」分区展开(VSCode 资源管理器下的大纲默认折叠)。 */
  readonly expanded: boolean;
  /** 跟随光标(VSCode outline.followCursor,默认开)。 */
  readonly followCursor: boolean;
  readonly sortBy: OutlineSortBy;
}

const DEFAULT_PREFS: OutlinePrefs = { expanded: false, followCursor: true, sortBy: 'position' };

function readPrefs(): OutlinePrefs {
  const raw = readStoredJson(OUTLINE_PREFS_KEY);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_PREFS;
  const r = raw as Record<string, unknown>;
  return {
    expanded: typeof r['expanded'] === 'boolean' ? r['expanded'] : DEFAULT_PREFS.expanded,
    followCursor: typeof r['followCursor'] === 'boolean' ? r['followCursor'] : DEFAULT_PREFS.followCursor,
    sortBy: r['sortBy'] === 'name' || r['sortBy'] === 'position' ? r['sortBy'] : DEFAULT_PREFS.sortBy,
  };
}

interface OutlineState extends OutlinePrefs {
  /** 折叠的节(行 id,见 outline-model)。 */
  readonly collapsed: ReadonlySet<string>;
  readonly filter: string;
  /** 键盘活动行(行 id);null = 无。 */
  readonly activeId: string | null;
  /** 递增:请求把焦点移进大纲树(「聚焦到大纲视图」命令)。 */
  readonly focusRequest: number;
  setExpanded: (expanded: boolean) => void;
  setFollowCursor: (follow: boolean) => void;
  setSortBy: (sortBy: OutlineSortBy) => void;
  setFilter: (filter: string) => void;
  setCollapsed: (id: string, collapsed: boolean) => void;
  /** 递增:请求全部折叠(大纲正文按当前符号树兑现)。 */
  readonly collapseAllRequest: number;
  requestCollapseAll: () => void;
  /** 全部折叠:ids = 所有有子项的行。 */
  collapseAll: (ids: readonly string[]) => void;
  setActiveId: (id: string | null) => void;
  requestFocus: () => void;
}

function persist(s: OutlinePrefs): void {
  writeRecord(OUTLINE_PREFS_KEY, { expanded: s.expanded, followCursor: s.followCursor, sortBy: s.sortBy });
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export const useOutlineStore = create<OutlineState>((set, get) => ({
  ...readPrefs(),
  collapsed: EMPTY_SET,
  filter: '',
  activeId: null,
  focusRequest: 0,
  collapseAllRequest: 0,
  requestCollapseAll: () => set((s) => ({ collapseAllRequest: s.collapseAllRequest + 1 })),
  setExpanded: (expanded) => {
    if (get().expanded === expanded) return;
    set({ expanded });
    persist(get());
  },
  setFollowCursor: (followCursor) => {
    if (get().followCursor === followCursor) return;
    set({ followCursor });
    persist(get());
  },
  setSortBy: (sortBy) => {
    if (get().sortBy === sortBy) return;
    set({ sortBy });
    persist(get());
  },
  setFilter: (filter) => set((s) => (s.filter === filter ? s : { filter: clampSearchQuery(filter) })),
  setCollapsed: (id, collapsed) =>
    set((s) => {
      if (s.collapsed.has(id) === collapsed) return s;
      const next = new Set(s.collapsed);
      if (collapsed) next.add(id);
      else next.delete(id);
      return { collapsed: next };
    }),
  collapseAll: (ids) => set({ collapsed: new Set(ids) }),
  setActiveId: (activeId) => set((s) => (s.activeId === activeId ? s : { activeId })),
  requestFocus: () => {
    set((s) => ({ expanded: true, focusRequest: s.focusRequest + 1 }));
    persist(get());
  },
}));

/** 测试用:恢复默认(不读 localStorage)。 */
export function __resetOutlineStoreForTest(): void {
  useOutlineStore.setState({ ...DEFAULT_PREFS, collapsed: EMPTY_SET, filter: '', activeId: null, focusRequest: 0, collapseAllRequest: 0 });
}
