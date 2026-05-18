import type { DockviewApi } from 'dockview-react';
import { tWithFallback } from '@/i18n/translate';

// Explorer 固定在左侧 sidebar(App.tsx 内的 ExplorerSidebar),不参与 Dockview。
// 默认布局极简(VSCode 风):只 Editor 占主区。
// Terminal / Output 通过 HeaderActions 的 + 按钮按需打开,无需常驻底部。
export function applyDefaultLayout(api: DockviewApi) {
  const editor = api.addPanel({
    id: 'editor',
    component: 'editor',
    title: tWithFallback('panels.editor.title', 'Editor'),
    params: { titleKey: 'panels.editor.title' },
  });
  editor.api.setActive();
}
