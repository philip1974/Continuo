// 内置 '插件' SettingTab(M-Plugin v3.5)。
// 显示插件系统自检:已注册各类贡献点的数量与列表,作为开发时观察 + 用户了解
// 当前激活的功能。第三方插件管理(enable/disable UI)等 v4 IPC backend 接入。
//
// 顺手注册全局命令 'settings.open'(⌘,),Mac 用户的肌肉记忆。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { PluginsTabContent } from '@/plugins/settings/PluginsTabContent';
import { useSettingsStore } from '@/plugins/settings/store';

export default class PluginsTabPlugin extends Plugin {
  onload(): void {
    this.addSettingTab({
      id: 'core.plugins',
      title: '插件',
      priority: 50,
      render: () => createElement(PluginsTabContent),
    });

    this.addCommand({
      id: 'settings.open',
      title: '打开 Settings',
      hotkey: 'mod+,',
      fn: () => useSettingsStore.getState().open(),
    });
  }
}
