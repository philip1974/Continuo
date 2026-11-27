// dock 组的大小调整(对齐 VSCode 编辑器组;BDD: src/__tests__/dock-group-sizes/):
// - 双击组之间的分隔条 → 该分隔条所在的那一排(同一 splitview)等分(VSCode sash onDidReset → Grid.onDidSashReset →
//   gridview.distributeViewSizes(parentLocation);编辑器组没有 preferredWidth/Height,总是走等分);
// - 双击 tab → 切换组大小(workbench.editor.doubleClickTabToToggleEditorGroupSizes 默认 'expand',EditorPart.toggleExpandGroup):
//   该组已「展开」(沿途每一级的其它兄弟都已缩到最小)→ 全部等分(GroupsArrangement.EVEN = gridWidget.distributeViewSizes(),
//   整个网格递归);否则展开它(gridview.expandView:沿途每一级把它 resizeChild 到 +∞,兄弟缩到最小);少于 2 个组 → 不动;
// - tab 右键「最大化组 / 取消最大化组」(VSCode workbench.action.toggleMaximizeEditorGroup)= dockview maximizeGroup /
//   exitMaximizedGroup(同 ⇧⌘Enter 终端缩放所用的原生最大化)。
// 只作用于主窗网格里的组(floating / popout 组不在网格里,没有分隔条可调)。
// dockview 6 没有公开的分隔条双击 / 等分 / 展开 API:经 api.component.gridview 的分支节点(BranchNode:children + splitview)
// 调 splitview 自带的 distributeViewSizes / resizeView,再按拖动分隔条结束时同一路径(BranchNode._onDidChange)通知布局变化
// (触发 onDidLayoutChange → 布局持久化)。内部结构不符(升级后改名)→ 静默不动。

import type { DockviewApi, DockviewGroupPanel } from 'dockview-react';
import type { TabMenuEntry } from '@/lib/TabContextMenu';

interface SplitviewLike {
  readonly sashes?: ReadonlyArray<{ readonly container?: unknown }>;
  distributeViewSizes(): void;
}

interface GridNodeLike {
  readonly minimumSize: number;
  readonly view?: unknown;
  readonly children?: readonly GridNodeLike[];
}

interface BranchLike extends GridNodeLike {
  /** 'HORIZONTAL':子节点从左到右排列;'VERTICAL':从上到下。 */
  readonly orientation?: string;
  readonly children: readonly GridNodeLike[];
  readonly splitview: SplitviewLike;
  readonly _onDidChange?: { fire(event: object): void };
  getChildSize(index: number): number;
  resizeChild(index: number, size: number): void;
  isChildVisible(index: number): boolean;
}

function isBranch(node: GridNodeLike | undefined): node is BranchLike {
  const n = node as Partial<BranchLike> | undefined;
  return (
    Array.isArray(n?.children) &&
    typeof n?.splitview?.distributeViewSizes === 'function' &&
    typeof n.resizeChild === 'function' &&
    typeof n.getChildSize === 'function'
  );
}

/** 网格根(BranchNode);内部结构不符 → undefined。 */
function gridRoot(api: DockviewApi): BranchLike | undefined {
  const component = (api as unknown as { component?: { gridview?: { root?: GridNodeLike } } }).component;
  const root = component?.gridview?.root;
  return isBranch(root) ? root : undefined;
}

/** 网格的根元素(分隔条的事件委托挂在这里)。 */
function gridElement(api: DockviewApi): HTMLElement | undefined {
  const component = (api as unknown as { component?: { gridview?: { element?: unknown } } }).component;
  const el = component?.gridview?.element as HTMLElement | undefined;
  return el && typeof el.addEventListener === 'function' ? el : undefined;
}

/** 按拖动分隔条结束时同一路径通知布局变化(沿父分支冒泡到网格 → onDidLayoutChange)。 */
function notifyChanged(branch: BranchLike): void {
  branch._onDidChange?.fire({});
}

function findBranchOfSash(node: GridNodeLike, sash: unknown): BranchLike | undefined {
  if (!isBranch(node)) return undefined;
  if (node.splitview.sashes?.some((s) => s.container === sash)) return node;
  for (const child of node.children) {
    const found = findBranchOfSash(child, sash);
    if (found) return found;
  }
  return undefined;
}

/** 双击的分隔条所在那一排等分(VSCode Grid.onDidSashReset)。不是网格的分隔条 → false。 */
export function distributeSashSizes(api: DockviewApi, sash: unknown): boolean {
  const root = gridRoot(api);
  const branch = root && findBranchOfSash(root, sash);
  if (!branch) return false;
  branch.splitview.distributeViewSizes();
  notifyChanged(branch);
  return true;
}

/** 从根到组所在叶子的路径:每一级的分支与组在其中的下标。不在网格里 → undefined。 */
function pathToGroup(node: GridNodeLike, group: DockviewGroupPanel): Array<{ branch: BranchLike; index: number }> | undefined {
  if (!isBranch(node)) return undefined;
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i]!;
    if (child.view === group) return [{ branch: node, index: i }];
    const rest = pathToGroup(child, group);
    if (rest) return [{ branch: node, index: i }, ...rest];
  }
  return undefined;
}

function gridGroupCount(node: GridNodeLike): number {
  if (!isBranch(node)) return 1;
  let n = 0;
  for (const child of node.children) n += gridGroupCount(child);
  return n;
}

/** 组已「展开」:沿途每一级里其它可见兄弟都已是最小尺寸(VSCode BranchNode.isChildExpanded)。 */
export function isGroupExpanded(api: DockviewApi, group: DockviewGroupPanel): boolean {
  const root = gridRoot(api);
  const path = root && pathToGroup(root, group);
  if (!path) return false;
  for (const { branch, index } of path) {
    for (let i = 0; i < branch.children.length; i += 1) {
      if (i === index || !branch.isChildVisible(i)) continue;
      if (branch.getChildSize(i) > branch.children[i]!.minimumSize) return false;
    }
  }
  return true;
}

function distributeAll(branch: BranchLike): void {
  branch.splitview.distributeViewSizes();
  for (const child of branch.children) if (isBranch(child)) distributeAll(child);
}

/**
 * 双击 tab 切换组大小(VSCode toggleExpandGroup):已展开 → 整个网格等分;否则展开该组。组不在主窗网格 / 网格里不足 2 个组 → false。
 */
export function toggleExpandGroup(api: DockviewApi, group: DockviewGroupPanel): boolean {
  const root = gridRoot(api);
  const path = root && pathToGroup(root, group);
  if (!root || !path || gridGroupCount(root) < 2) return false;
  if (isGroupExpanded(api, group)) {
    distributeAll(root);
  } else {
    for (const { branch, index } of path) branch.resizeChild(index, Number.POSITIVE_INFINITY);
  }
  notifyChanged(root);
  return true;
}

/** 子树最左上的组(紧贴该子树左缘 / 上缘)。 */
function firstLeafView(node: GridNodeLike): unknown {
  let cur: GridNodeLike | undefined = node;
  while (isBranch(cur)) cur = cur.children[0];
  return cur?.view;
}

/**
 * 网格里紧挨着该组右侧的组(VSCode findGroup({ direction: RIGHT }) = gridWidget 的右邻视图,取最上面那个):沿路径向上找最近的
 * 横向分支里它右边的兄弟子树,取其最左上的组。右边没有组 / 不在网格里 → undefined。
 */
export function rightNeighborGroup(api: DockviewApi, group: DockviewGroupPanel): DockviewGroupPanel | undefined {
  const root = gridRoot(api);
  const path = root && pathToGroup(root, group);
  if (!path) return undefined;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const { branch, index } = path[i]!;
    if (branch.orientation !== 'HORIZONTAL' || index >= branch.children.length - 1) continue;
    return firstLeafView(branch.children[index + 1]!) as DockviewGroupPanel | undefined;
  }
  return undefined;
}

/** 「最大化组」可用:组在主窗网格里且网格里不止它一个组(VSCode precondition:多个编辑器组或已最大化)。 */
export function canMaximizeGroup(api: DockviewApi, group: DockviewGroupPanel): boolean {
  if (group.api.location?.type !== 'grid') return false;
  if (group.api.isMaximized()) return true;
  const root = gridRoot(api);
  return root !== undefined && gridGroupCount(root) > 1;
}

/** tab 右键「最大化组 / 取消最大化组」(VSCode toggleMaximizeEditorGroup)。 */
export function toggleMaximizeGroup(api: DockviewApi, group: DockviewGroupPanel): void {
  if (group.api.isMaximized()) {
    api.exitMaximizedGroup();
    return;
  }
  const panel = group.activePanel;
  if (!panel || !canMaximizeGroup(api, group)) return;
  api.maximizeGroup(panel);
}

/** 双击组之间的分隔条 → 等分(挂在网格根元素上的事件委托)。 */
export function trackSashReset(api: DockviewApi): { dispose: () => void } {
  const el = gridElement(api);
  if (!el) return { dispose: () => {} };
  const onDblClick = (e: MouseEvent) => {
    const target = e.target as { classList?: DOMTokenList } | null;
    if (!target?.classList?.contains('dv-sash')) return;
    if (distributeSashSizes(api, target)) e.preventDefault();
  };
  el.addEventListener('dblclick', onDblClick);
  return { dispose: () => el.removeEventListener('dblclick', onDblClick) };
}

/**
 * tab 右键菜单末尾的「最大化组 / 取消最大化组」(VSCode toggleMaximizeEditorGroup;dockview 原生最大化,同 ⇧⌘Enter 终端缩放)。
 * 组不在主窗网格里 / 网格里只有它一个组 → 不列。dock tab 与编辑器 tab 共用。BDD: src/__tests__/dock-group-sizes/
 */
export function groupSizeMenuEntries(
  containerApi: DockviewApi,
  group: DockviewGroupPanel,
  t: (key: 'shell.tab.ctx.maximize_group' | 'shell.tab.ctx.unmaximize_group') => string,
): TabMenuEntry[] {
  if (!canMaximizeGroup(containerApi, group)) return [];
  const maximized = group.api.isMaximized();
  return [
    'separator',
    {
      label: t(maximized ? 'shell.tab.ctx.unmaximize_group' : 'shell.tab.ctx.maximize_group'),
      onSelect: () => toggleMaximizeGroup(containerApi, group),
    },
  ];
}
