import type { SerializedDockview } from 'dockview-react';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { CONFLICT_DIFF_PANEL_TYPE } from '@/panels/Editor/conflict-diff-constants';

/**
 * 不进持久化布局的面板类型:终端(由 DockReconciler 依 live session 重建)、保存冲突差异 tab(冲突是一次性的会话状态,
 * 重启后磁盘 / 文档都已不同,不恢复;BDD: src/__tests__/editor-save-conflict-compare/)。下文「终端」泛指这些面板。
 */
const NON_PERSISTED_PANEL_TYPES: ReadonlySet<string> = new Set([TERMINAL_PANEL_TYPE, CONFLICT_DIFF_PANEL_TYPE]);

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

type FloatingGroup = { data?: LeafData; gridReferenceGroup?: unknown } & Record<
  string,
  unknown
>;

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
 * 只剪「剥掉终端之后才变空」的 leaf、每个非根 branch ≥1 child、悬空的 activeView/activeGroup 回退。
 * 空 leaf 的保留规则:**存活**(剥离后仍保留)popout 的 `gridReferenceGroup` 指向的 leaf 一律保留
 * (空 views)—— 否则 fromJSON 时 popout 失去锚点,关闭弹窗后面板无处回归;原本就空的可见 leaf
 * (dockview 自身会产生并原样持久化)保留;原本就空的隐藏 leaf(`visible:false`,只由整组弹出产生)
 * 若其 popout 已被丢弃(全是终端)则失去锚点,摘除 —— 否则 fromJSON 恢复成无人显示 / 移除的隐藏空组,
 * 每次重启多积一个。
 *
 * @returns 剥离后的新 layout;无终端时返回原对象(引用不变,回归友好);grid、floating、popout
 *          三处都没有非终端 panel / 缺 grid 无法安全处理 → null(上层走默认布局,静默,不报错)。
 *          grid 被剪空但 floating/popout 仍有非终端 panel → grid root 保留为空 branch。
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
    if (p?.contentComponent !== undefined && NON_PERSISTED_PANEL_TYPES.has(p.contentComponent)) terminalIds.add(id);
  }
  if (terminalIds.size === 0) return layout; // 无终端,原样返回(引用不变)

  const grid = (layout as unknown as { grid?: { root?: GridNode } }).grid;
  if (!grid || typeof grid !== 'object' || !grid.root) return null; // 缺 grid,无法安全剥离

  // 存活 group id 集合(grid leaf + floating/popout),用于回退悬空 activeGroup。
  const survivingGroupIds = new Set<string>();
  // 存活的非终端 view 数(grid + floating + popout);为 0 才整份弃用。
  let survivingViewCount = 0;
  // 存活 popout 的 grid 锚点组:即便为空也保留,fromJSON 时 popout 才有引用组可挂。
  // 须在剪 grid 之前由「剥离后保留的 popout」填充(见下方 popout 过滤)。
  const popoutReferenceIds = new Set<string>();

  // keepEmpty(仅 grid leaf):为空时是否保留。原本即空的可见 leaf 保留;其余空组只在是存活 popout 引用组时保留。
  const filterGroupData = (
    raw: LeafData | undefined,
    keepEmpty?: { hidden: boolean },
  ): LeafData | null => {
    const data = raw ?? EMPTY_LEAF_DATA;
    const rawViews = Array.isArray(data.views) ? data.views : EMPTY_PANEL_IDS;
    const groupId = typeof data.id === 'string' ? data.id : null;
    const isPopoutReference = groupId !== null && popoutReferenceIds.has(groupId);
    if (rawViews.length === 0) {
      if (!keepEmpty || (keepEmpty.hidden && !isPopoutReference)) return null;
      if (groupId !== null) survivingGroupIds.add(groupId);
      return data;
    }
    const views = new Array<string>(rawViews.length);
    let viewCount = 0;
    for (const view of rawViews) {
      if (!terminalIds.has(view)) {
        views[viewCount] = view;
        viewCount += 1;
      }
    }
    views.length = viewCount;
    if (views.length === 0) {
      // 该 group 仅含终端 → 整组摘除;popout 引用组则保留为空组(剔除终端 tabGroups/activeView)。
      if (!keepEmpty || !isPopoutReference) return null;
      survivingGroupIds.add(groupId);
      const emptied: LeafData = { ...data, views };
      delete emptied.activeView;
      delete emptied.tabGroups;
      return emptied;
    }
    survivingViewCount += viewCount;
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
      const data = filterGroupData(node.data, { hidden: node.visible === false });
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

  const filterFloating = (groups: FloatingGroup[]): FloatingGroup[] => {
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
  // 先过滤 popout:只有剥离后仍保留的 popout 的引用组才算锚点(被丢弃的 popout 不再需要锚点)。
  const rawPopouts = (layout as unknown as { popoutGroups?: unknown })
    .popoutGroups;
  const keptPopouts = Array.isArray(rawPopouts)
    ? filterFloating(rawPopouts as FloatingGroup[])
    : null;
  if (keptPopouts) {
    for (const g of keptPopouts) {
      if (typeof g.gridReferenceGroup === 'string')
        popoutReferenceIds.add(g.gridReferenceGroup);
    }
  }

  // grid 被剪空时 root 保留为空 branch(dockview 空 grid 的原生形态),floating/popout 可能仍有存活面板。
  const root =
    pruneNode(grid.root) ??
    (grid.root.type === 'branch' ? { ...grid.root, data: new Array<GridNode>(0) } : null);
  if (!root) return null;

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

  if (Array.isArray(result.floatingGroups))
    result.floatingGroups = filterFloating(result.floatingGroups);
  if (keptPopouts) result.popoutGroups = keptPopouts;

  // grid、floating、popout 三处都没有非终端 panel → 走默认布局。
  if (survivingViewCount === 0) return null;

  // activeGroup 指向被整体摘除的 group → 清掉,避免 dockview 反序列化引用悬空 group。
  if (result.activeGroup && !survivingGroupIds.has(result.activeGroup)) {
    delete result.activeGroup;
  }

  return result as unknown as SerializedDockview;
}
