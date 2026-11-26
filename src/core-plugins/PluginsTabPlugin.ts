// 内置 '插件' SettingTab(M-Plugin v3.5)。
// 显示插件系统自检(已注册各类贡献点的数量与列表)+ 用户插件管理(安装 / 启停 / 重载 / 权限 / 卸载)。
//
// 全局命令 'settings.toggle'(⌘,)在 SettingsPanelPlugin 注册。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel, preloadableLazy } from '@/lib/lazy-panel';
import { MarketplaceIcon, PluginsIcon } from '@/plugins/settings/tab-icons';

// 插件管理 UI(列表 / 权限编辑 / 更新)懒加载到独立 chunk,不进 main-app 启动包;模块级只包一次保组件类型稳定。
// 经 preloadableLazy:随设置外壳预取后首次点开页签同步渲染,不再内容区空白约 300ms(BDD: core-plugins)。
const pluginsTabContent = preloadableLazy(() =>
  import('@/plugins/settings/PluginsTabContent').then((m) => ({
    default: m.PluginsTabContent,
  })),
);
const PluginsTab = lazyPanel(pluginsTabContent.Component);

// MarketplaceTab 拉 reviews 渲染、远端清单 UI 等;懒加载到独立 chunk。
const marketplaceTab = preloadableLazy(() =>
  import('@/marketplace/MarketplaceTab').then((m) => ({
    default: m.MarketplaceTab,
  })),
);
const MarketplaceTabPanel = lazyPanel(marketplaceTab.Component);

/** 预取插件市场 / 插件两个页签 chunk(SettingsPanelPlugin 的 lazy 工厂随设置外壳一并发起)。 */
export function preloadPluginsTabs(): Promise<unknown> {
  return Promise.all([marketplaceTab.preload(), pluginsTabContent.preload()]);
}

export default class PluginsTabPlugin extends Plugin {
  onload(): void {
    // 插件市场在前(priority 数字小排前)
    this.addSettingTab({
      id: 'core.marketplace',
      title: 'Marketplace',
      titleKey: 'settings.plugins.market_title',
      priority: 40,
      icon: createElement(MarketplaceIcon),
      render: MarketplaceTabPanel,
    });

    this.addSettingTab({
      id: 'core.plugins',
      title: 'Plugins',
      titleKey: 'settings.plugins.tab_title',
      priority: 50,
      icon: createElement(PluginsIcon),
      render: PluginsTab,
    });

    // settings.toggle 命令 + ⌘, hotkey 已搬到 SettingsPanelPlugin。
  }
}
