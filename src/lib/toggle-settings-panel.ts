// Settings panel 入口的统一 toggle helper(VSCode `View: Toggle X` 风格)。
// 所有调用方(settings.toggle 命令 / IconSidebar 齿轮 / 命令面板)走同一路径。
//
// 行为:
//   - panel 不存在 → 打开 + 收起 Explorer 侧栏(为 Settings 让出宽度)
//   - panel 存在且 active(用户正看着 Settings)→ 关闭(再次按 ⌘, 收回)
//   - panel 存在但 inactive(被其他 tab 遮住)→ 聚焦它 + 收起侧栏
//   - dock 未就绪 → 静默忽略(开机时序保护)
//
// 关闭 Settings 不自动恢复 sidebar — 尊重用户在 Settings 打开期间手动展开。
//
// BDD: settings-toggle

import { getDockApi, openOrFocusPanel } from '@/shell/dock/dock-api-ref';
import { useLayoutUiStore } from '@/stores/layout-ui.store';

const SETTINGS_PANEL_ID = 'settings';
const SETTINGS_COMPONENT = 'settings';
const SETTINGS_TITLE = 'Settings';
const SETTINGS_TITLE_KEY = 'panels.settings.title';

export function toggleSettingsPanel(): void {
  const api = getDockApi();
  if (!api) return;

  const existing = api.getPanel(SETTINGS_PANEL_ID);
  if (existing && existing.api.isActive) {
    existing.api.close();
    return;
  }

  useLayoutUiStore.getState().setSidebarOpen(false);

  // 「存在则聚焦 / 不存在则新建」走共享 openOrFocusPanel:它负责撤销排定中的关闭动画(否则刚聚焦的
  // Settings 会在 EXIT_DURATION_MS 后消失)并带上 params.titleKey(页签标题随语言切换)。此前这里手抄了
  // 一份,两样都漏了。
  openOrFocusPanel(SETTINGS_PANEL_ID, SETTINGS_COMPONENT, SETTINGS_TITLE, SETTINGS_TITLE_KEY);
}
