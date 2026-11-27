// 大纲视图命令(VSCode outline.focus「资源管理器: 聚焦到大纲视图」,无默认键;可在快捷键页绑定)。BDD: src/__tests__/markdown-outline/

import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { focusMainWindowFromPopout } from '@/shell/dock/main-window-focus';
import { useOutlineStore } from './outline-store';

export const FOCUS_OUTLINE_COMMAND_ID = 'outline.focus';

/** 显示侧栏、展开大纲分区并把焦点移进大纲(侧栏在主窗:从 popout 子窗触发先激活主窗)。 */
export function focusOutlineView(): void {
  focusMainWindowFromPopout();
  useLayoutUiStore.getState().setSidebarOpen(true);
  useOutlineStore.getState().requestFocus();
}

export function outlineCommandSpecs(): CommandSpec[] {
  return [
    {
      id: FOCUS_OUTLINE_COMMAND_ID,
      title: 'Focus on Outline View',
      titleKey: 'commands.outline.focus.title',
      category: 'Explorer',
      categoryKey: 'commands.explorer.category',
      fn: focusOutlineView,
    },
  ];
}
