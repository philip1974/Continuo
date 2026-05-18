// 内置 '插件' SettingTab(M-Plugin v3.5)。
// 显示插件系统自检:已注册各类贡献点的数量与列表,作为开发时观察 + 用户了解
// 当前激活的功能。第三方插件管理(enable/disable UI)等 v4 IPC backend 接入。
//
// 全局命令 'settings.toggle'(⌘,)在 SettingsPanelPlugin 注册。

import { createElement, lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { PluginsTabContent } from '@/plugins/settings/PluginsTabContent';
import { lazyPanel } from '@/lib/lazy-panel';
import { MarketplaceIcon, PluginsIcon } from '@/plugins/settings/tab-icons';

// MarketplaceTab 拉 reviews 渲染、远端清单 UI 等;懒加载到独立 chunk。
const MarketplaceTab = lazy(() =>
  import('@/marketplace/MarketplaceTab').then((m) => ({
    default: m.MarketplaceTab,
  })),
);

export default class PluginsTabPlugin extends Plugin {
  onload(): void {
    // 插件商店在前(priority 数字小排前;现有 Sample 是 80,Plugins 50)
    this.addSettingTab({
      id: 'core.marketplace',
      title: 'Plugin Market',
      titleKey: 'settings.plugins.market_title',
      priority: 40,
      icon: createElement(MarketplaceIcon),
      render: lazyPanel(MarketplaceTab),
    });

    this.addSettingTab({
      id: 'core.plugins',
      title: 'Plugins',
      titleKey: 'settings.plugins.tab_title',
      priority: 50,
      icon: createElement(PluginsIcon),
      render: () => createElement(PluginsTabContent),
    });

    // settings.toggle 命令 + ⌘, hotkey 已搬到 SettingsPanelPlugin。
  }
}
