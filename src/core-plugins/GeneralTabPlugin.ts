// 内置「通用」SettingTab + 通用类设置项(M-Settings v6)。
// SettingItemRegistry 的首个使用者:注册一个 select 类型的「主题」item,
// 渲染走 CategoryTabContent(category='general'),控件由 SettingItemRow
// 自动渲染 SegmentedControl;主题由 ThemeProvider 直接读取本值(唯一存储)。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { renderCategoryTab } from './lazy-category-tab';
import { GeneralIcon } from '@/plugins/settings/tab-icons';
import {
  EDITOR_ACCESSIBILITY_SUPPORT,
  GENERAL_RESTORE_WINDOWS,
  GENERAL_THEME,
  SCREENCAST_FONT_SIZE,
  SCREENCAST_KEYBOARD_OVERLAY_TIMEOUT,
  SCREENCAST_VERTICAL_OFFSET,
  WINDOW_ZOOM_LEVEL,
  WORKBENCH_ACTIVITY_BAR_LOCATION,
  WORKBENCH_STATUS_BAR_VISIBLE,
  WORKBENCH_TRUSTED_DOMAINS,
} from '@/plugins/settings/core-setting-specs';

export default class GeneralTabPlugin extends Plugin {
  onload(): void {
    // priority 1:第一个 tab(其余内置 tab 的 priority 见各自的 *TabPlugin)
    this.addSettingTab({
      id: 'core.general',
      title: 'General',
      titleKey: 'settings.general.tab_title',
      priority: 1,
      icon: createElement(GeneralIcon),
      render: () => renderCategoryTab('general'),
    });

    // 主题 setting item(spec 单一来源见 core-setting-specs;ThemeProvider 直接以它为唯一存储)
    this.addSettingItem(GENERAL_THEME);
    // 启动时恢复所有窗口(VSCode window.restoreWindows;RestoreWindowsFromSettings 推给 main)
    this.addSettingItem(GENERAL_RESTORE_WINDOWS);
    // 缩放级别(VSCode window.zoomLevel;ZoomLevelFromSettings 推给 main,所有窗口统一)
    this.addSettingItem(WINDOW_ZOOM_LEVEL);
    // 读屏优化(VSCode editor.accessibilitySupport;终端 screenReaderMode 按它 + 系统检测判定)
    this.addSettingItem(EDITOR_ACCESSIBILITY_SUPPORT);
    // 外链受信域名(VSCode 链接保护的受信域名;值在 main,行由 TrustedDomainsSettingRow 渲染)
    this.addSettingItem(WORKBENCH_TRUSTED_DOMAINS);
    // 状态栏 / 活动栏显隐(VSCode workbench.statusBar.visible / workbench.activityBar.location;BDD: src/__tests__/workbench-layout-visibility/)
    this.addSettingItem(WORKBENCH_STATUS_BAR_VISIBLE);
    this.addSettingItem(WORKBENCH_ACTIVITY_BAR_LOCATION);
    // 屏幕录制模式的按键浮层(VSCode screencastMode.*;BDD: src/__tests__/screencast-mode/)
    this.addSettingItem(SCREENCAST_FONT_SIZE);
    this.addSettingItem(SCREENCAST_VERTICAL_OFFSET);
    this.addSettingItem(SCREENCAST_KEYBOARD_OVERLAY_TIMEOUT);
  }
}
