import type { DockviewApi } from 'dockview-react';
import { tWithFallback } from '@/i18n/translate';

// Explorer 固定在左侧 sidebar(App.tsx 内的 ExplorerSidebar),不参与 Dockview。
// 默认布局极简(VSCode 风):只 Editor 占主区。
// Terminal / Output 通过 HeaderActions 的 + 按钮按需打开,无需常驻底部。
//
// Idempotent guard (topic 47): React 18 StrictMode 双 mount + DockShell 两处
// callsite (onReady fallback + restore from EmptyState) 都可能让本函数跑两次。
// 第二次 api.addPanel({id:'editor'}) 会 throw "panel with id editor already
// exists"。check existence + 复活已有 editor focus 而非 throw。
export function applyDefaultLayout(api: DockviewApi) {
  const existing = api.getPanel('editor');
  if (existing) {
    existing.api.setActive();
    return;
  }
  const editor = api.addPanel({
    id: 'editor',
    component: 'editor',
    title: tWithFallback('panels.editor.title', 'Editor'),
    params: { titleKey: 'panels.editor.title' },
  });
  editor.api.setActive();
}
