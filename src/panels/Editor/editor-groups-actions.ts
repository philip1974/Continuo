// 编辑器组的工作台动作(对齐 VSCode):拆分编辑器(workbench.action.splitEditor / splitEditorDown、tab 右键「向右拆分」)
// 与聚焦第 N 个编辑器组(workbench.action.focusFirst/Second/ThirdEditorGroup)。组 = 一个 editor dock 面板,
// 组的内容在 editor.store(BDD: src/__tests__/editor-groups/)。
// 本模块不静态引入编辑引擎(EditorHeader / EditorPlugin 的命令都引用它)。

import { getDockApi } from '@/shell/dock/dock-api-ref';
import { activateDockPanel } from '@/shell/dock/wrap-panel-close';
import { focusPanelContent } from '@/shell/dock/panel-focus';
import { mainEditorGroupOrder } from '@/shell/dock/editor-group-order';
import { editorGroupIdsOf, groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { tWithFallback } from '@/i18n/translate';
import { nextEditorGroupId } from '../../../electron/shared/editor-group-id';
import { saveCodeEditorViewState, snapshotCodeEditorView } from './editor-view-state-cache';
import { requestEditorFocus } from './editor-focus-registry';

export type SplitDirection = 'right' | 'down';

export interface SplitEditorOptions {
  /** 源组(缺省活动组)。 */
  readonly groupId?: string;
  /** 拆分哪个文件(缺省源组的活动文件);null = 新建空组(⌘N 聚焦尚不存在的下一个组)。 */
  readonly tabId?: string | null;
}

/**
 * 在源组的右侧 / 下方新建编辑器组并打开该文件(同一文档,共享内容与脏状态),新组成为活动组并获焦。
 * 源组没有可拆分的文件 / 源组面板不在 dock 里 / 组数已达上限 → false。
 */
export function splitEditor(direction: SplitDirection, opts: SplitEditorOptions = {}): boolean {
  const api = getDockApi();
  if (!api) return false;
  const store = useEditorStore.getState();
  const source = opts.groupId ?? store.activeGroupId;
  const sourcePanel = api.getPanel(source);
  if (!sourcePanel) return false;
  const tabId = opts.tabId === undefined ? groupActiveTabIdOf(store, source) : opts.tabId;
  const newId = nextEditorGroupId([...editorGroupIdsOf(store), ...api.panels.map((p) => p.id)]);
  // 新组的视图从源视图的当前状态起步(VSCode 拆分复制视图状态:光标 / 滚动 / 撤销历史):源 CodeMirror 视图还挂着,
  // 先把它的状态存进按文档共享的视图状态缓存,新视图挂载时取用。
  const live = tabId === null ? undefined : store.viewRefs.get(tabId);
  if (tabId !== null && live) saveCodeEditorViewState(tabId, snapshotCodeEditorView(live));
  if (!store.splitGroup(source, newId, tabId)) return false;
  const options = {
    id: newId,
    component: 'editor',
    title: tWithFallback('panels.editor.title', 'Editor'),
    params: { titleKey: 'panels.editor.title' },
  };
  if (!api.getPanel(newId)) {
    try {
      api.addPanel({ ...options, position: { referencePanel: sourcePanel, direction: direction === 'right' ? 'right' : 'below' } });
    } catch {
      // popout / 浮动组不能再分栏:作为同一 dock 组里的另一个面板
      api.addPanel({ ...options, position: { referencePanel: sourcePanel, direction: 'within' } });
    }
  }
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
