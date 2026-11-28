// 编辑器组的工作台动作(对齐 VSCode):拆分编辑器(workbench.action.splitEditor / splitEditorDown、tab 右键「向右拆分」)、
// 聚焦第 N 个编辑器组(workbench.action.focusFirst…EighthEditorGroup)、移动编辑器(moveEditorToNext/Previous/First/LastGroup、
// moveEditorLeft/RightInGroup)与合并组(joinTwoGroups / joinAllGroups)。组 = 一个 editor dock 面板,
// 组的内容在 editor.store(BDD: src/__tests__/editor-groups/、src/__tests__/editor-tab-management/)。
// 本模块不静态引入编辑引擎(EditorHeader / EditorPlugin 的命令都引用它)。

import { getDockApi } from '@/shell/dock/dock-api-ref';
import { activateDockPanel } from '@/shell/dock/wrap-panel-close';
import { focusPanelContent } from '@/shell/dock/panel-focus';
import { editorGroupsInWindowOf, mainEditorGroupOrder } from '@/shell/dock/editor-group-order';
import { activePanelInDocument, editorGroupInDocument } from '@/shell/dock/group-mru';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import {
  editorGroupIdsOf,
  groupActiveTabIdOf,
  groupTabsOf,
  liveEditorViewOf,
  useEditorStore,
} from '@/stores/editor.store';
import { tWithFallback } from '@/i18n/translate';
import { isEditorGroupId, nextEditorGroupId } from '../../../electron/shared/editor-group-id';
import {
  markdownScrollTopOf,
  saveCodeEditorViewState,
  saveMarkdownScrollTop,
  snapshotCodeEditorView,
  takeCodeEditorViewState,
} from './editor-view-state-cache';
import { flushEditorWriteBacks } from './editor-writeback-registry';
import { requestEditorFocus } from './editor-focus-registry';

/**
 * 编辑器组类命令作用的组:触发命令的窗口(按键所在窗口 / 命令面板所在窗口)的编辑器组(VSCode:命令作用于触发它的窗口的
 * 活动编辑器组;见 editorGroupInDocument)。dock 未就绪 → 活动编辑器组;该窗口没有编辑器组 → undefined(命令 no-op)。
 * 只在命令的同步部分有效(getCommandDocument)。
 */
export function commandEditorGroupId(): string | undefined {
  const active = useEditorStore.getState().activeGroupId;
  const api = getDockApi();
  return api ? editorGroupInDocument(api, getCommandDocument(), active) : active;
}

/**
 * tab 级命令(移动编辑器、按序号打开、下一个 / 上一个编辑器)作用的组:同 commandEditorGroupId,但触发窗口的活动 dock 面板不是编辑器组
 *(设置页 / 冲突比较页等)且该编辑器组被它挡住(不可见)时 → undefined(命令 no-op),不去动用户看不见的文件。VSCode 里设置 / 比较页
 * 本身是编辑器,这些命令作用于它;Continuo 里它们是 dock 面板,不归编辑器组管。活动面板在别的组(编辑器组仍可见,如焦点在旁边的
 * 终端)→ 照旧作用于该编辑器组(VSCode:焦点在面板区终端时同样作用于活动编辑器组)。
 */
export function visibleCommandEditorGroupId(): string | undefined {
  const groupId = commandEditorGroupId();
  const api = getDockApi();
  if (groupId === undefined || !api) return groupId;
  const active = activePanelInDocument(api, getCommandDocument());
  if (!active || isEditorGroupId(active.id)) return groupId;
  return api.getPanel(groupId)?.api.isVisible === false ? undefined : groupId;
}

/** 命令只用 right / down;left / up 供把资源管理器的文件拖到组的左 / 上边缘(VSCode 按落点四向拆分)。 */
export type SplitDirection = 'right' | 'down' | 'left' | 'up';

const DOCK_DIRECTION = { right: 'right', down: 'below', left: 'left', up: 'above' } as const;

export interface SplitEditorOptions {
  /** 源组(缺省触发窗口的编辑器组,见 commandEditorGroupId)。 */
  readonly groupId?: string;
  /** 拆分哪个文件(缺省源组的活动文件);null = 新建空组(⌘N 聚焦尚不存在的下一个组)。 */
  readonly tabId?: string | null;
  /** 新组获焦(缺省 true);false = 只建组不动焦点(资源管理器 ⌥ 单击在侧边打开,VSCode preserveFocus)。 */
  readonly focus?: boolean;
}

/**
 * 在源组的右侧 / 下方新建编辑器组并打开该文件(同一文档,共享内容与脏状态),新组成为活动组并获焦。
 * 源组没有可拆分的文件 / 源组面板不在 dock 里 / 组数已达上限 → false。
 */
export function splitEditor(direction: SplitDirection, opts: SplitEditorOptions = {}): boolean {
  const api = getDockApi();
  if (!api) return false;
  const store = useEditorStore.getState();
  const source = opts.groupId ?? commandEditorGroupId();
  const sourcePanel = source === undefined ? undefined : api.getPanel(source);
  if (source === undefined || !sourcePanel) return false;
  const tabId = opts.tabId === undefined ? groupActiveTabIdOf(store, source) : opts.tabId;
  const newId = nextEditorGroupId([...editorGroupIdsOf(store), ...api.panels.map((p) => p.id)]);
  // 新组的视图从源组视图的当前状态起步(VSCode 拆分复制视图状态:光标 / 滚动 / 折叠 / 撤销历史):源组的 CodeMirror 视图
  // 还挂着,先把它的状态存成新组的视图状态,新视图挂载时取用(视图状态按组 + 文件;BDD: src/__tests__/editor-view-state-groups/)。
  const live = tabId === null ? undefined : liveEditorViewOf(tabId, source);
  if (tabId !== null && live) saveCodeEditorViewState(tabId, snapshotCodeEditorView(live), newId);
  if (!store.splitGroup(source, newId, tabId)) return false;
  const options = {
    id: newId,
    component: 'editor',
    title: tWithFallback('panels.editor.title', 'Editor'),
    params: { titleKey: 'panels.editor.title' },
  };
  if (!api.getPanel(newId)) {
    try {
      api.addPanel({ ...options, position: { referencePanel: sourcePanel, direction: DOCK_DIRECTION[direction] } });
    } catch {
      // popout / 浮动组不能再分栏:作为同一 dock 组里的另一个面板
      api.addPanel({ ...options, position: { referencePanel: sourcePanel, direction: 'within' } });
    }
  }
  if (opts.focus === false) return true;
  if (tabId !== null) requestEditorFocus(tabId, newId);
  else {
    const panel = api.getPanel(newId);
    if (panel) queueMicrotask(() => focusPanelContent(panel.api));
  }
  return true;
}

/**
 * 聚焦第 index 个(1 起,按空间顺序 —— 网格从左到右、从上到下,同 dock 标题「编辑器 N」,VSCode GRID_APPEARANCE)编辑器组:激活其面板并聚焦其活动编辑器(空组 → 面板根)。index 恰为「组数 + 1」→
 * 在最后一个组右侧新建空组并聚焦(VSCode 同);更大 → no-op。
 * 只数主窗(grid / floating)里的组:⌘1/⌘2/⌘3 只在主窗分发(popout 子窗不分发),VSCode 按触发窗口自己的编辑器组编号 ——
 * 子窗里的组不计入、也不作新建组的参照(否则新组建进子窗、顶替子窗原显示的内容)。
 */
export function focusEditorGroup(index: number): void {
  const api = getDockApi();
  if (!api) return;
  const store = useEditorStore.getState();
  const ids = mainEditorGroupOrder(api);
  const id = ids[index - 1];
  if (id === undefined) {
    if (index === ids.length + 1) {
      const last = ids[ids.length - 1];
      if (last !== undefined) splitEditor('right', { groupId: last, tabId: null });
    }
    return;
  }
  const panel = api.getPanel(id);
  if (!panel) return;
  store.setActiveGroup(id);
  activateDockPanel(panel);
  const tabId = groupActiveTabIdOf(useEditorStore.getState(), id);
  if (tabId !== null) requestEditorFocus(tabId, id);
  else queueMicrotask(() => focusPanelContent(panel.api));
}

/** groupId 所在窗口的编辑器组(按空间顺序,同 dock 标题「编辑器 N」);dock 未就绪 → store 的组顺序。只含 store 里存在的组。 */
export function editorGroupsInWindow(groupId: string): string[] {
  const api = getDockApi();
  const live = editorGroupIdsOf(useEditorStore.getState());
  const order = api ? editorGroupsInWindowOf(api, groupId) : live;
  const out = order.filter((id) => live.includes(id));
  return out.includes(groupId) ? out : [groupId, ...out];
}

/** 在组 groupId 里激活 tabId 并聚焦其编辑器(该组成为活动组、其 dock 面板激活)。 */
export function openEditorInGroup(groupId: string, tabId: string): void {
  useEditorStore.getState().switchTab(tabId, { groupId });
  const panel = getDockApi()?.getPanel(groupId);
  if (panel) activateDockPanel(panel);
  requestEditorFocus(tabId, groupId);
}

/**
 * 把组 from 里的 tabId 移到组 to(跨组;store.moveTab):先回写编辑器里尚未上抛的输入(脏内容跟随),目标组还没有它时把源组的视图状态
 *(光标 / 选区 / 滚动 / 折叠 / 撤销历史;隐藏 tab 取缓存里的)交给目标组(VSCode 移动编辑器带视图状态,同拆分)。返回是否移动了。
 */
function moveTabAcrossGroups(tabId: string, from: string, to: string): boolean {
  flushEditorWriteBacks([tabId]);
  const store = useEditorStore.getState();
  if (!groupTabsOf(store, to).some((t) => t.id === tabId)) {
    const live = liveEditorViewOf(tabId, from);
    const entry = live ? snapshotCodeEditorView(live) : takeCodeEditorViewState(tabId, from);
    if (entry) saveCodeEditorViewState(tabId, entry, to);
    const scrollTop = markdownScrollTopOf(tabId, from);
    if (scrollTop !== undefined) saveMarkdownScrollTop(tabId, scrollTop, to);
  }
  return store.moveTab(tabId, from, to);
}

export type MoveEditorTarget = 'next' | 'previous' | 'first' | 'last' | 'left' | 'right';

/**
 * 移动编辑器(VSCode moveActiveEditor):'left' / 'right' = 组内左移 / 右移一位(到头不动);'next' / 'previous' / 'first' / 'last' = 移到
 * 所在窗口按空间顺序的下一个 / 上一个 / 第一个 / 最后一个组。没有下一个(上一个)组 → 向右(左)拆出新组再移过去;第一个 / 最后一个
 * 就是本组 → 不动(VSCode 同)。跨组后目标组成为活动组、编辑器获焦。缺省 = 触发窗口的编辑器组的活动 tab(该组被设置页等非编辑器面板
 * 挡住 → 不动,见 visibleCommandEditorGroupId)。返回是否移动了。
 */
export function moveEditor(to: MoveEditorTarget, opts: { readonly groupId?: string; readonly tabId?: string } = {}): boolean {
  const from = opts.groupId ?? visibleCommandEditorGroupId();
  if (from === undefined) return false;
  const store = useEditorStore.getState();
  const tabId = opts.tabId ?? groupActiveTabIdOf(store, from);
  if (tabId === null) return false;
  const tabs = groupTabsOf(store, from);
  const index = tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return false;
  if (to === 'left' || to === 'right') return store.moveTab(tabId, from, from, index + (to === 'left' ? -1 : 1));
  const order = editorGroupsInWindow(from);
  const at = order.indexOf(from);
  let target = to === 'next' ? order[at + 1] : to === 'previous' ? order[at - 1] : to === 'first' ? order[0] : order.at(-1);
  if (target === undefined) {
    if (!splitEditor(to === 'next' ? 'right' : 'left', { groupId: from, tabId: null, focus: false })) return false;
    target = useEditorStore.getState().activeGroupId;
  }
  if (target === from || !moveTabAcrossGroups(tabId, from, target)) return false;
  openEditorInGroup(target, tabId);
  return true;
}

/**
 * 合并组(VSCode joinTwoGroups / joinAllGroups):all = false → 把活动组并入相邻组(按空间顺序先找下一个,没有再找上一个;VSCode 依次
 * 找右 / 下 / 左 / 上);all = true → 所在窗口的其它组都并入活动组。并入的编辑器按顺序追加到目标组末尾(固定的仍固定),目标组已有的
 * 文件用目标组的那个;被并入的组变空后关闭。合并后目标组成为活动组,原活动编辑器在其中激活并获焦。
 */
export function joinEditorGroups(all: boolean): void {
  const active = commandEditorGroupId();
  if (active === undefined) return;
  const order = editorGroupsInWindow(active);
  const at = order.indexOf(active);
  const target = all ? active : (order[at + 1] ?? order[at - 1]);
  if (target === undefined) return;
  const sources = all ? order.filter((id) => id !== active) : [active];
  if (sources.length === 0) return;
  const focusTab = groupActiveTabIdOf(useEditorStore.getState(), active);
  for (const source of sources) {
    for (const tab of groupTabsOf(useEditorStore.getState(), source)) moveTabAcrossGroups(tab.id, source, target);
  }
  const s = useEditorStore.getState();
  const tabId = focusTab !== null && groupTabsOf(s, target).some((t) => t.id === focusTab) ? focusTab : groupActiveTabIdOf(s, target);
  if (tabId !== null) openEditorInGroup(target, tabId);
}
