// 内置 Settings Panel 插件(v5 Phase 5,VSCode 同款)。
//
// 注册 'settings' panel 类型 + 命令 'settings.toggle'(⌘,)。命令是 toggle:
// 不存在 → 打开 + 收起侧栏;已 active → 关闭;已存在但非 active → 聚焦。
//
// BDD:
//   - settings-panel(panel UI)
//   - settings-toggle(命令 + helper toggle 行为)

import { lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { toggleSettingsPanel } from '@/lib/toggle-settings-panel';

const SettingsPanel = lazy(() =>
  import('@/plugins/settings/SettingsPanel').then((m) => ({
    default: m.SettingsPanel,
  })),
);

export default class SettingsPanelPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'settings',
      title: 'Settings',
      titleKey: 'panels.settings.title',
      factory: lazyPanel(SettingsPanel),
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
