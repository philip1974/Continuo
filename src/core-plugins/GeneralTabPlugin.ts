// 内置「通用」SettingTab + 通用类设置项(M-Settings v6)。
// SettingItemRegistry 的首个使用者:注册一个 select 类型的「主题」item,
// 渲染走 CategoryTabContent(category='general'),控件由 SettingItemRow
// 自动渲染 SegmentedControl;主题由 ThemeProvider 直接读取本值(唯一存储)。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { renderCategoryTab } from './lazy-category-tab';
import { GeneralIcon } from '@/plugins/settings/tab-icons';
import { GENERAL_RESTORE_WINDOWS, GENERAL_THEME } from '@/plugins/settings/core-setting-specs';

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
  }
}
