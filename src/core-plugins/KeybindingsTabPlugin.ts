// 内置 'Settings → 快捷键' tab(2026-05)。
// 订阅 commands.getAll(),只列有 hotkey 的命令,按 category 分组,
// KeyCap 渲染。

import { createElement, lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { KeybindingsIcon } from '@/plugins/settings/tab-icons';

const KeybindingsTabContent = lazy(() =>
  import('@/plugins/settings/KeybindingsTabContent').then((m) => ({
    default: m.KeybindingsTabContent,
  })),
);

export default class KeybindingsTabPlugin extends Plugin {
  onload(): void {
    this.addSettingTab({
      id: 'core.keybindings',
      title: '快捷键',
      // 商店 40 / 插件 50,快捷键 60 排在它们后面
      priority: 60,
      icon: createElement(KeybindingsIcon),
      render: () => createElement(lazyPanel(KeybindingsTabContent)),
    });
  }
}
