// 内置 Settings Panel 插件(v5 Phase 5,VSCode 同款)。
//
// 注册 'settings' panel 类型 + 两条命令:
// - 'workbench.action.openSettings'(命令面板「首选项: 打开设置」、菜单「设置…」;VSCode 同 id):只打开 / 聚焦,已显示也不关。
// - 'settings.toggle'(⌘,,命令面板「查看: 切换设置」)是 toggle:不存在 → 打开 + 收起侧栏;已 active → 关闭;已存在但非 active
//   → 聚焦。刻意差异:VSCode 的 ⌘, 即 openSettings(不切换);本项目 ⌘, 再按收回设置是既有约定(BDD settings-toggle)。
//
// BDD:
//   - settings-panel(panel UI)
//   - settings-toggle(命令 + helper toggle 行为)

import { Plugin } from '@/plugins/Plugin';
import { lazyPanel, preloadableLazy } from '@/lib/lazy-panel';
import { openSettingsPanel, toggleSettingsPanel } from '@/lib/toggle-settings-panel';
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

/** 只打开 / 聚焦设置的命令(命令面板「首选项: 打开设置」、应用菜单「设置…」)。 */
export const OPEN_SETTINGS_COMMAND_ID = 'workbench.action.openSettings';

export default class SettingsPanelPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'settings',
      title: 'Settings',
      titleKey: 'panels.settings.title',
      factory: lazyPanel(settingsPanel.Component),
    });

    this.addCommand({
      // VSCode「Preferences: Open Settings」(workbench.action.openSettings,preferences.contribution.ts):只打开 / 聚焦。
      id: OPEN_SETTINGS_COMMAND_ID,
      title: 'Open Settings',
      titleKey: 'commands.preferences.open_settings.title',
      category: 'Preferences',
      categoryKey: 'commands.preferences.category',
      keywordsKey: 'commands.preferences.open_settings.keywords',
      fn: () => openSettingsPanel(),
    });
    this.addCommand({
      id: 'settings.toggle',
      title: 'Toggle Settings',
      titleKey: 'commands.view.toggle_settings.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      hotkey: 'mod+,',
      fn: () => toggleSettingsPanel(),
    });
  }
}
