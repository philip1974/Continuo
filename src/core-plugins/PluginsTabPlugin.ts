// 内置 '插件' SettingTab(M-Plugin v3.5)。
// 显示插件系统自检:已注册各类贡献点的数量与列表,作为开发时观察 + 用户了解
// 当前激活的功能。第三方插件管理(enable/disable UI)等 v4 IPC backend 接入。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { PluginsTabContent } from '@/plugins/settings/PluginsTabContent';

export default class PluginsTabPlugin extends Plugin {
  onload(): void {
    this.addSettingTab({
      id: 'core.plugins',
      title: '插件',
      priority: 50,
      render: () => createElement(PluginsTabContent),
    });
  }
}
