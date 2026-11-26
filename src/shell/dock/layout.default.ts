import type { DockviewApi, DockviewGroupPanel } from 'dockview-react';
import { tWithFallback } from '@/i18n/translate';
import { activateDockPanel } from './wrap-panel-close';
import { editorGroupIdsOf, useEditorStore } from '@/stores/editor.store';
import { mainEditorGroupOrder } from './editor-group-order';

// Explorer 固定在左侧 sidebar(App.tsx 内的 ExplorerSidebar),不参与 Dockview。
// 默认布局极简(VSCode 风):只 Editor 占主区。
// Terminal / Output 通过 HeaderActions 的 + 按钮按需打开,无需常驻底部。
//
// Idempotent guard (topic 47): React 18 StrictMode 双 mount + DockShell 两处
// callsite (onReady fallback + restore from EmptyState) 都可能让本函数跑两次。
// 第二次 api.addPanel({id:'editor'}) 会 throw "panel with id editor already
// exists"。check existence + 复活已有 editor focus 而非 throw。
export function applyDefaultLayout(api: DockviewApi, group?: DockviewGroupPanel) {
  // 编辑器面板 id = 活动编辑器组 id(拆分后只剩 editor:2 时恢复的是它,不另起一个空的 editor 组;BDD: editor-groups)
  const id = useEditorStore.getState().activeGroupId;
  const existing = api.getPanel(id);
  if (existing) {
    activateDockPanel(existing);
    return;
  }
  const editor = api.addPanel({
    id,
    component: 'editor',
    title: tWithFallback('panels.editor.title', 'Editor'),
    params: { titleKey: 'panels.editor.title' },
    // 指定组(重置布局的落点组)→ 建在其中;否则落在活动组
    ...(group ? { position: { referenceGroup: group } } : {}),
  });
  editor.api.setActive();
}

/**
 * 「视图:重置布局」(VSCode View: Reset View Locations 类;空状态的「恢复默认布局」同一实现):把拖乱的布局收回默认形态
 * —— 退出最大化;拆分 / 浮动 / popout 子窗里的非编辑器面板收回主窗主编辑器组(popout 子窗随之关闭);编辑器组不合并
 *(VSCode 重置只动视图):第二个及以后的编辑器组(按空间顺序)各自成组,依次在主编辑器组右侧分栏;再按默认布局补上并激活编辑器。
 * **不关闭任何面板**:编辑器组(含未保存的 tab)、运行中的终端都原样保留,只换位置(同拖动 tab),无需确认。
 * BDD: src/__tests__/dock-reset-layout/
 */
export function resetDockLayout(api: DockviewApi): void {
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  const withPanels = api.groups.filter((g) => g.panels.length > 0);
  if (withPanels.length === 0) {
    applyDefaultLayout(api);
    return;
  }
  const isGrid = (g: DockviewGroupPanel | undefined): g is DockviewGroupPanel => g?.api.location.type === 'grid';
  // 编辑器组按主窗里的空间顺序(网格从左到右、从上到下,同 ⌘1/⌘2/⌘3),popout 子窗里的按 store 组顺序排在后面,
  // 都不在的排最后。
  const order = [...new Set([...mainEditorGroupOrder(api), ...editorGroupIdsOf(useEditorStore.getState())])];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const editors = api.panels
    .filter((p) => p.view.contentComponent === 'editor')
    .sort((a, b) => rank(a.id) - rank(b.id));
  const [primary, ...others] = editors;
  // 落点:主编辑器所在的主窗组 > 第一个有面板的主窗组 > 新建主窗组(面板全在子窗 / 浮动时)。
  const main = (isGrid(primary?.group) ? primary.group : withPanels.find(isGrid)) ?? api.addGroup();
  const editorSet = new Set(editors);
  for (const panel of [...api.panels]) {
    if (panel.group !== main && (panel === primary || !editorSet.has(panel))) {
      panel.api.moveTo({ group: main, position: 'center', skipSetActive: true });
    }
  }
  // 其余编辑器组依次分栏在前一个编辑器组右侧(同组叠着的 / 浮动 / 子窗里的都拆出来)。
  let previous = main;
  for (const panel of others) {
    panel.api.moveTo({ group: previous, position: 'right', skipSetActive: true });
    previous = panel.group;
  }
  // 编辑器面板已关 → 建在落点组(各面板移动时不换活动组,活动组可能已随清空被移除)
  applyDefaultLayout(api, main);
}
