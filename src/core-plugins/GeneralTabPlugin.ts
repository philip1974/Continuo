// 内置「通用」SettingTab + 通用类设置项(M-Settings v6)。
// SettingItemRegistry 的首个使用者:注册一个 select 类型的「主题」item,
// 渲染走 CategoryTabContent(category='general'),控件由 SettingItemRow
// 自动渲染 SegmentedControl;ThemeProvider 通过 ThemeFromSettings 桥同步。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { CategoryTabContent } from '@/plugins/settings/CategoryTabContent';
import { GeneralIcon } from '@/plugins/settings/tab-icons';

export default class GeneralTabPlugin extends Plugin {
  onload(): void {
    // priority 1:第一个 tab(快捷键 priority 100,插件 50,商店 40)
    this.addSettingTab({
      id: 'core.general',
      title: '通用',
      titleKey: 'settings.general.tab_title',
      priority: 1,
      icon: createElement(GeneralIcon),
      render: () => createElement(CategoryTabContent, { category: 'general' }),
    });

    // 主题 setting item:select 类型,选项 light / dark / system
    // ThemeProvider 内的 ThemeFromSettings 监听本值变化即时调 setMode
    this.addSettingItem({
      id: 'general.theme',
      category: 'general',
      title: '主题',
      titleKey: 'settings.general.theme.title',
      description: '选择 Continuo 的视觉主题。system 跟随操作系统。',
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
