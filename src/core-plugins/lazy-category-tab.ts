// 通用 / 编辑器 / 资源管理器 / 终端 四个设置 tab 共用的懒加载内容(perf:不把 CategoryTabContent 与
// SettingItemRow 等控件打进 main-app 启动包;四个 tab 共享一个 chunk)。模式同 KeybindingsTabPlugin。

import type { ReactNode } from 'react';
import { lazyPanel, preloadableLazy } from '@/lib/lazy-panel';

const importCategoryTabContent = () => import('@/plugins/settings/CategoryTabContent');

// 经 preloadableLazy:预取完成后分类内容随设置外壳同步挂载,不再在外壳出现后再挂起约 300ms 才显示(BDD: open-panel-focus)。
const categoryTabContent = preloadableLazy(() =>
  importCategoryTabContent().then((m) => ({ default: m.CategoryTabContent })),
);
// 「插件设置」页签内容与 CategoryTabContent 同一 chunk(BDD: plugin-settings-section)。
const pluginSettingsTabContent = preloadableLazy(() =>
  importCategoryTabContent().then((m) => ({ default: m.PluginSettingsTabContent })),
);

/**
 * 预取 CategoryTabContent chunk(唯一 import 入口)。SettingsPanelPlugin 的 lazy 工厂复用它与设置外壳并行预取
 * (同一 specifier → 同一模块实例,模块缓存去重);同时让本文件的两个分类内容组件预取完成后挂载不经 Suspense 挂起。
 */
export function loadCategoryTabContent(): Promise<unknown> {
  return Promise.all([categoryTabContent.preload(), pluginSettingsTabContent.preload()]);
}

// 模块级只包一次:render 每次返回同一组件类型(渲染期新建会让 tab 内容随父组件重渲而卸载重挂)。
const CategoryTab = lazyPanel(categoryTabContent.Component);

export function renderCategoryTab(category: string): ReactNode {
  return CategoryTab({ category });
}

export const renderPluginSettingsTab = lazyPanel(pluginSettingsTabContent.Component);
