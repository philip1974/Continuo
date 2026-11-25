// Settings panel 入口的统一 toggle helper(VSCode `View: Toggle X` 风格)。
// 所有调用方(settings.toggle 命令 / IconSidebar 齿轮 / 命令面板)走同一路径。
//
// 行为:
//   - panel 不存在 → 打开 + 收起 Explorer 侧栏(为 Settings 让出宽度)
//   - panel 在主窗正显示(主窗的活动面板;活动组在 popout 子窗时取主窗最近使用组的活动面板)→ 关闭(再次按 ⌘, 收回)
//   - panel 存在但主窗没在显示它(被其他 tab 遮住 / 在 popout 子窗里)→ 在其所在窗口激活(子窗另聚焦)+ 收起侧栏
//   - panel 不存在且活动组在 popout 子窗 → 新建在主窗(见 openOrFocusPanelNow)
//   - dock 未就绪 → 静默忽略(开机时序保护)
//   - 布局待恢复 → 排队,恢复完成后按届时的实际面板状态判断(恢复出的 active Settings 会被关闭,
//     恢复前连按两次相互抵消)
//
// 关闭 Settings 不自动恢复 sidebar — 尊重用户在 Settings 打开期间手动展开。
//
// BDD: settings-toggle

import { openOrFocusPanel, runWhenDockLayoutReady } from '@/shell/dock/dock-api-ref';
import type { DockviewApi } from 'dockview-react';
import { mainWindowActivePanel } from '@/shell/dock/group-mru';
import { useLayoutUiStore } from '@/stores/layout-ui.store';

const SETTINGS_PANEL_ID = 'settings';
const SETTINGS_COMPONENT = 'settings';
const SETTINGS_TITLE = 'Settings';
const SETTINGS_TITLE_KEY = 'panels.settings.title';

export function toggleSettingsPanel(): void {
  runWhenDockLayoutReady(toggleSettingsPanelNow);
}

function toggleSettingsPanelNow(api: DockviewApi): void {
  const existing = api.getPanel(SETTINGS_PANEL_ID);
  // 只在触发窗口(主窗:齿轮 / 菜单 / 命令面板 / ⌘, 都在主窗)里正显示时才关闭。在 popout 子窗里(即便是活动面板)→ 不关
  // 看不见的面板,改为在其所在窗口激活并聚焦该子窗;活动组在子窗、但主窗正显示着设置 → 照常关闭。
  const inPopout = existing?.api.location?.type === 'popout';
  if (existing && !inPopout && (existing.api.isActive || mainWindowActivePanel(api) === existing)) {
    existing.api.close();
    return;
  }

  // 收起侧栏是为主窗里的 Settings 让出宽度;Settings 在子窗里时主窗布局不动。
  if (!inPopout) useLayoutUiStore.getState().setSidebarOpen(false);

  // 「存在则聚焦 / 不存在则新建」走共享 openOrFocusPanel:它负责撤销排定中的关闭动画(否则刚聚焦的
  // Settings 会在 EXIT_DURATION_MS 后消失)并带上 params.titleKey(页签标题随语言切换)。此前这里手抄了
  // 一份,两样都漏了。
  openOrFocusPanel(SETTINGS_PANEL_ID, SETTINGS_COMPONENT, SETTINGS_TITLE, SETTINGS_TITLE_KEY);
}
