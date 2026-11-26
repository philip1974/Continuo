// 内置「插件设置」SettingTab(BDD: src/__tests__/plugin-settings-section/)。
// 插件用内置之外的 category 注册的设置项没有对应页签 —— 对齐 VSCode 设置编辑器的「扩展」节点,统一收进本页签按插件分节。
// 只在存在这类设置项时注册页签;插件禁用 / 卸载使其设置项全部注销后撤下页签。

import { createElement } from 'react';
import { Plugin, type Disposable } from '@/plugins/Plugin';
import { isPluginSettingItem, PLUGIN_SETTINGS_TAB_ID } from '@/plugins/settings/plugin-setting-sections';
import { PluginSettingsIcon } from '@/plugins/settings/tab-icons';
import { renderPluginSettingsTab } from './lazy-category-tab';

export default class PluginSettingsTabPlugin extends Plugin {
  onload(): void {
    let tab: Disposable | null = null;
    const sync = (): void => {
      const needed = this.app.settingItems.getAll().some(isPluginSettingItem);
      if (needed && tab === null) {
        tab = this.addSettingTab({
          id: PLUGIN_SETTINGS_TAB_ID,
          title: 'Plugin Settings',
          titleKey: 'settings.plugin_settings.tab_title',
          // 快捷键 60 之后(VSCode「扩展」节点在目录末尾)
          priority: 70,
          icon: createElement(PluginSettingsIcon),
          render: renderPluginSettingsTab,
        });
      } else if (!needed && tab !== null) {
        tab.dispose();
        tab = null;
      }
    };
    const unsubscribe = this.app.settingItems.subscribe(sync);
    this.register({ dispose: unsubscribe });
    sync();
  }
}
