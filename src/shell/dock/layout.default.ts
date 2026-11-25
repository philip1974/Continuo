import type { DockviewApi } from 'dockview-react';
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
