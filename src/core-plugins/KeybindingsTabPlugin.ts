// 内置 'Settings → 快捷键' tab(2026-05)。
// 订阅 commands.getAll(),只列有 hotkey 的命令,按 category 分组,
// KeyCap 渲染。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel, preloadableLazy } from '@/lib/lazy-panel';
import { KeybindingsIcon } from '@/plugins/settings/tab-icons';
import { useSettingsStore } from '@/plugins/settings/store';
import { openSettingsPanel } from '@/lib/toggle-settings-panel';

export const KEYBINDINGS_SETTING_TAB_ID = 'core.keybindings';

/**
 * 首选项:打开键盘快捷方式(VSCode workbench.action.openGlobalKeybindings):打开设置并切到快捷键页,焦点落到该页搜索框;
 * 设置已打开时切到该页。VSCode 默认键是 ⌘K ⌘S 和弦,键位模型不支持和弦 → 不给默认键(命令面板 / 菜单 / 可自行绑定)。
 * BDD: src/__tests__/app-menu-bar/
 */
export const OPEN_KEYBINDINGS_COMMAND_ID = 'workbench.action.openGlobalKeybindings';

export function openKeybindingsSettings(): void {
  useSettingsStore.getState().showTabWithSearchFocus(KEYBINDINGS_SETTING_TAB_ID);
  openSettingsPanel();
}

// 经 preloadableLazy:随设置外壳预取后首次点开页签同步渲染,不再内容区空白约 300ms(BDD: core-plugins)。
const keybindingsTabContent = preloadableLazy(() =>
  import('@/plugins/settings/KeybindingsTabContent').then((m) => ({
    default: m.KeybindingsTabContent,
  })),
);
/** 预取快捷键页签 chunk(SettingsPanelPlugin 的 lazy 工厂随设置外壳一并发起)。 */
export const preloadKeybindingsTab = keybindingsTabContent.preload;

// 模块级只包一次:render 每次返回同一组件类型(渲染期新建会让 tab 内容随父组件重渲而卸载重挂)。
const KeybindingsTab = lazyPanel(keybindingsTabContent.Component);

export default class KeybindingsTabPlugin extends Plugin {
  onload(): void {
    this.addSettingTab({
      id: KEYBINDINGS_SETTING_TAB_ID,
      title: 'Keybindings',
      titleKey: 'settings.keybindings.tab_title',
      // 商店 40 / 插件 50,快捷键 60 排在它们后面
      priority: 60,
      icon: createElement(KeybindingsIcon),
      render: KeybindingsTab,
    });

    this.addCommand({
      id: OPEN_KEYBINDINGS_COMMAND_ID,
      title: 'Open Keyboard Shortcuts',
      titleKey: 'commands.preferences.open_keybindings.title',
      category: 'Preferences',
      categoryKey: 'commands.preferences.category',
      keywordsKey: 'commands.preferences.open_keybindings.keywords',
      fn: () => openKeybindingsSettings(),
    });
  }
}
