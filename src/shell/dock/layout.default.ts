import type { DockviewApi, DockviewGroupPanel } from 'dockview-react';
import { tWithFallback } from '@/i18n/translate';
import { activateDockPanel } from './wrap-panel-close';
import { useEditorStore } from '@/stores/editor.store';

// Explorer 固定在左侧 sidebar(App.tsx 内的 ExplorerSidebar),不参与 Dockview。
// 默认布局极简(VSCode 风):只 Editor 占主区。
// Terminal / Output 通过 HeaderActions 的 + 按钮按需打开,无需常驻底部。
//
// Idempotent guard (topic 47): React 18 StrictMode 双 mount + DockShell 两处
// callsite (onReady fallback + restore from EmptyState) 都可能让本函数跑两次。
// 第二次 api.addPanel({id:'editor'}) 会 throw "panel with id editor already
// exists"。check existence + 复活已有 editor focus 而非 throw。
export function applyDefaultLayout(api: DockviewApi) {
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
  });
  editor.api.setActive();
}

/**
 * 「视图:重置布局」(VSCode View: Reset View Locations 类;空状态的「恢复默认布局」同一实现):把拖乱的布局收回默认形态
 * —— 退出最大化;拆分 / 浮动 / popout 子窗里的所有面板收回主窗同一个组(popout 子窗随之关闭);再按默认布局补上并激活编辑器。
 * **不关闭任何面板**:编辑器组(含未保存的 tab)、运行中的终端都原样保留,只换位置(同拖动 tab),无需确认。
 * BDD: src/__tests__/dock-reset-layout/
 */
export function resetDockLayout(api: DockviewApi): void {
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  const withPanels = api.groups.filter((g) => g.panels.length > 0);
  if (withPanels.length > 0) {
    const isGrid = (g: DockviewGroupPanel | undefined): g is DockviewGroupPanel => g?.api.location.type === 'grid';
    const editorGroup = api.getPanel(useEditorStore.getState().activeGroupId)?.group;
    // 落点:编辑器所在的主窗组 > 第一个有面板的主窗组 > 新建主窗组(面板全在子窗 / 浮动时)。
    const target = (isGrid(editorGroup) ? editorGroup : withPanels.find(isGrid)) ?? api.addGroup();
    for (const group of withPanels) {
      if (group !== target) group.api.moveTo({ group: target, position: 'center', skipSetActive: true });
    }
  }
  applyDefaultLayout(api);
}
