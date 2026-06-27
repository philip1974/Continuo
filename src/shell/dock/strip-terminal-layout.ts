import type { SerializedDockview } from 'dockview-react';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';

// dockview 序列化布局的局部窄化类型(toJSON 产出 JSON,字段松散,故就地窄化而非依赖
// dockview 内部类型)。leaf.data 为 group 状态(views/activeView/id/tabGroups),
// branch.data 为子节点数组。
type LeafData = {
  views?: string[];
  activeView?: string;
  id?: string;
  tabGroups?: Array<{ panelIds?: string[] } & Record<string, unknown>>;
  [k: string]: unknown;
};
type GridNode =
  | ({ type: 'leaf'; data: LeafData } & Record<string, unknown>)
  | ({ type: 'branch'; data: GridNode[] } & Record<string, unknown>);

type FloatingGroup = { data?: LeafData } & Record<string, unknown>;

const EMPTY_FLOATING_GROUPS: FloatingGroup[] = [];
const EMPTY_LEAF_DATA: LeafData = {};
const EMPTY_PANEL_IDS: string[] = [];
const EMPTY_GRID_CHILDREN: GridNode[] = [];

/**
 * 从已序列化的 dockview 布局里剥离 terminal panel,保留其余(editor 等)非终端布局。
 *
 * 背景:终端是真实 dockview panel,toJSON 会把它们写进持久化 layout。但既有契约是
 * 「终端不从持久化 layout 恢复」—— 终端由 DockReconciler 依据 live session 列表重建。
 * 旧实现一旦发现持久 layout 含终端就整体弃用(返 null)→ 连带丢弃 editor 等非终端布局,
 * 并被上层当作「布局恢复失败」弹红色 error toast(误报,关窗时开着终端=每次必现)。
 * 本函数只摘掉终端 panel + 修补 grid 树,让非终端布局正常存活、不再误报。
 *
 * dockview 反序列化按深度自动分配 orientation(每层 orthogonal 翻转),与子节点数量无关,
 * 故单子节点 branch 仍能正确渲染(仅冗余一层嵌套),无需危险的 branch 塌缩 —— 只需保证
 * 每个 leaf ≥1 view、每个 branch ≥1 child、悬空的 activeView/activeGroup 回退。
 *
 * @returns 剥离后的新 layout;无终端时返回原对象(引用不变,回归友好);若无任何非终端
 *          panel 残留 / 缺 grid 无法安全处理 → null(上层走默认布局,静默,不报错)。
 */
export function stripTerminalPanelsFromLayout(
  layout: SerializedDockview,
): SerializedDockview | null {
  const panels = (layout?.panels ?? null) as Record<
    string,
    { contentComponent?: string }
  > | null;
  if (!panels || typeof panels !== 'object') return layout ?? null;

  const terminalIds = new Set<string>();
  for (const id in panels) {
    if (!Object.prototype.hasOwnProperty.call(panels, id)) continue;
    const p = panels[id];
    if (p?.contentComponent === TERMINAL_PANEL_TYPE) terminalIds.add(id);
  }
  if (terminalIds.size === 0) return layout; // 无终端,原样返回(引用不变)

  const grid = (layout as unknown as { grid?: { root?: GridNode } }).grid;
  if (!grid || typeof grid !== 'object' || !grid.root) return null; // 缺 grid,无法安全剥离

  // 存活 group id 集合(grid leaf + floating/popout),用于回退悬空 activeGroup。
  const survivingGroupIds = new Set<string>();

  const filterGroupData = (raw: LeafData | undefined): LeafData | null => {
    const data = raw ?? EMPTY_LEAF_DATA;
    const rawViews = Array.isArray(data.views) ? data.views : EMPTY_PANEL_IDS;
    if (rawViews.length === 0) return null;
    const views = new Array<string>(rawViews.length);
    let viewCount = 0;
    for (const view of rawViews) {
      if (!terminalIds.has(view)) {
        views[viewCount] = view;
        viewCount += 1;
      }
    }
    views.length = viewCount;
    if (views.length === 0) return null; // 该 group 仅含终端 → 整组摘除
    const activeView =
      data.activeView && views.includes(data.activeView)
        ? data.activeView
        : views[0];
    const next: LeafData = { ...data, views, activeView };
    // tabGroups(罕见高级特性):同步剔除终端 panelIds,丢弃变空的 tabGroup。
    if (Array.isArray(data.tabGroups)) {
      const tabGroups = new Array<
        { panelIds?: string[] } & Record<string, unknown>
      >(data.tabGroups.length);
      let tabGroupCount = 0;
      for (const tg of data.tabGroups) {
        const rawPanelIds = Array.isArray(tg.panelIds)
          ? tg.panelIds
          : EMPTY_PANEL_IDS;
        if (rawPanelIds.length === 0) continue;
        const panelIds = new Array<string>(rawPanelIds.length);
        let panelIdCount = 0;
        for (const id of rawPanelIds) {
          if (!terminalIds.has(id)) {
            panelIds[panelIdCount] = id;
            panelIdCount += 1;
          }
        }
        panelIds.length = panelIdCount;
        if (panelIds.length > 0) {
          tabGroups[tabGroupCount] = { ...tg, panelIds };
          tabGroupCount += 1;
        }
      }
      tabGroups.length = tabGroupCount;
      next.tabGroups = tabGroups;
    }
    if (typeof data.id === 'string') survivingGroupIds.add(data.id);
    return next;
  };

  const pruneNode = (node: GridNode): GridNode | null => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'leaf') {
      const data = filterGroupData(node.data);
      return data ? { ...node, data } : null;
    }
    // branch:递归剪枝,丢弃变空的子节点;子节点全空则本 branch 也摘除。
    const rawChildren = Array.isArray(node.data)
      ? node.data
      : EMPTY_GRID_CHILDREN;
    if (rawChildren.length === 0) return null;
    const children = new Array<GridNode>(rawChildren.length);
    let childCount = 0;
    for (const child of rawChildren) {
      const pruned = pruneNode(child);
      if (pruned !== null) {
        children[childCount] = pruned;
        childCount += 1;
      }
    }
    children.length = childCount;
    if (children.length === 0) return null;
    return { ...node, data: children };
  };

  const root = pruneNode(grid.root);
  if (!root) return null; // 整棵树无非终端 panel → 走默认布局

  const nextPanels: Record<string, unknown> = {};
  for (const id in panels) {
    if (!Object.prototype.hasOwnProperty.call(panels, id)) continue;
    if (!terminalIds.has(id)) nextPanels[id] = panels[id];
  }

  // 可变工作类型(松散)与严格的 SerializedDockview 解耦,避免 floatingGroups(要求 position 等)
  // 求交冲突;末尾一次性 cast 回。
  type Mutable = {
    grid: { root: GridNode };
    panels: Record<string, unknown>;
    activeGroup?: string;
    floatingGroups?: FloatingGroup[];
    popoutGroups?: FloatingGroup[];
    [k: string]: unknown;
  };
  const result: Mutable = {
    ...(layout as unknown as Record<string, unknown>),
    grid: { ...grid, root },
    panels: nextPanels,
  };

  const filterFloating = (
    groups: FloatingGroup[] | undefined,
  ): FloatingGroup[] | undefined => {
    if (!Array.isArray(groups)) return groups;
    if (groups.length === 0) return EMPTY_FLOATING_GROUPS;
    let kept: FloatingGroup[] | null = null;
    let keptCount = 0;
    for (const g of groups) {
      const data = filterGroupData(g?.data);
      if (data) {
        kept ??= new Array<FloatingGroup>(groups.length);
        kept[keptCount] = { ...g, data };
        keptCount += 1;
      }
    }
    if (kept === null) return EMPTY_FLOATING_GROUPS;
    kept.length = keptCount;
    return kept;
  };
  if (Array.isArray(result.floatingGroups))
    result.floatingGroups = filterFloating(result.floatingGroups);
  if (Array.isArray(result.popoutGroups))
    result.popoutGroups = filterFloating(result.popoutGroups);

  // activeGroup 指向被整体摘除的 group → 清掉,避免 dockview 反序列化引用悬空 group。
  if (result.activeGroup && !survivingGroupIds.has(result.activeGroup)) {
    delete result.activeGroup;
  }

  return result as unknown as SerializedDockview;
}
