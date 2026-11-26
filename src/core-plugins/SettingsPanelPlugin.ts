// 内置 Settings Panel 插件(v5 Phase 5,VSCode 同款)。
//
// 注册 'settings' panel 类型 + 命令 'settings.toggle'(⌘,)。命令是 toggle:
// 不存在 → 打开 + 收起侧栏;已 active → 关闭;已存在但非 active → 聚焦。
//
// BDD:
//   - settings-panel(panel UI)
//   - settings-toggle(命令 + helper toggle 行为)

import { Plugin } from '@/plugins/Plugin';
import { lazyPanel, preloadableLazy } from '@/lib/lazy-panel';
import { toggleSettingsPanel } from '@/lib/toggle-settings-panel';
import { loadCategoryTabContent } from './lazy-category-tab';
import { preloadPluginsTabs } from './PluginsTabPlugin';
import { preloadKeybindingsTab } from './KeybindingsTabPlugin';

// perf:设置首开时外壳 chunk 与默认分类 tab 的 CategoryTabContent chunk 同时发起,不再「外壳加载渲染后才拉
// 分类内容」两级瀑布。分类预取 fire-and-forget:不阻塞外壳,失败吞掉(分类 tab 自己的 lazy 照常重新 import)。
// 插件市场 / 插件 / 快捷键页签 chunk 同样随外壳预取:首次点开这些页签,内容与左侧高亮同步出现,不再空白约 300ms。
const settingsPanel = preloadableLazy(() => {
  loadCategoryTabContent().catch(() => {});
  preloadPluginsTabs().catch(() => {});
  preloadKeybindingsTab().catch(() => {});
  return import('@/plugins/settings/SettingsPanel').then((m) => ({
    default: m.SettingsPanel,
  }));
});
/** 启动空闲时预取(main-app):冷启动 ⌘, 后搜索框同步挂载,立刻键入不丢字。BDD: src/__tests__/open-panel-focus/ */
export const preloadSettingsPanel = settingsPanel.preload;

export default class SettingsPanelPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'settings',
      title: 'Settings',
      titleKey: 'panels.settings.title',
      factory: lazyPanel(settingsPanel.Component),
    });

    this.addCommand({
      id: 'settings.toggle',
      title: 'Toggle Settings',
      titleKey: 'commands.settings.toggle.title',
      category: 'Settings',
      categoryKey: 'commands.settings.category',
      hotkey: 'mod+,',
      fn: () => toggleSettingsPanel(),
    });
  }
}
