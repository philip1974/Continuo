// 内置「通用」SettingTab + 通用类设置项(M-Settings v6)。
// SettingItemRegistry 的首个使用者:注册一个 select 类型的「主题」item,
// 渲染走 CategoryTabContent(category='general'),控件由 SettingItemRow
// 自动渲染 SegmentedControl;主题由 ThemeProvider 直接读取本值(唯一存储)。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { renderCategoryTab } from './lazy-category-tab';
import { GeneralIcon } from '@/plugins/settings/tab-icons';

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

    // 主题 setting item:select 类型,选项 light / dark / system
    // ThemeProvider 直接订阅本值,变化即时切换
    this.addSettingItem({
      id: 'general.theme',
      category: 'general',
      title: 'Theme',
      titleKey: 'settings.general.theme.title',
      descriptionKey: 'settings.general.theme.description',
      type: 'select',
      default: 'dark',
      enum: [
        { value: 'light', label: 'Light', labelKey: 'settings.general.theme.light' },
        { value: 'dark', label: 'Dark', labelKey: 'settings.general.theme.dark' },
        { value: 'system', label: 'System', labelKey: 'settings.general.theme.system' },
      ],
      priority: 1,
    });
  }
}
