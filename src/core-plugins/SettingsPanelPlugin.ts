// 内置 Settings Panel 插件(v5 Phase 5,VSCode 同款)。
//
// 注册 'settings' panel 类型 + 命令 'settings.open'(⌘,)。
// 取代旧 SettingsModal — modal 已彻底删除。
//
// BDD: src/__tests__/settings-panel/

import { lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { openOrFocusPanel } from '@/shell/dock/dock-api-ref';

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
      factory: lazyPanel(SettingsPanel),
    });

    this.addCommand({
      id: 'settings.open',
      title: '打开 Settings',
      category: 'Settings',
      hotkey: 'mod+,',
      fn: () => openOrFocusPanel('settings', 'settings', 'Settings'),
    });
  }
}
