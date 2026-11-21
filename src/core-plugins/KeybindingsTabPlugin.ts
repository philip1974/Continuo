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

// 模块级只包一次:render 每次返回同一组件类型(渲染期新建会让 tab 内容随父组件重渲而卸载重挂)。
const KeybindingsTab = lazyPanel(KeybindingsTabContent);

export default class KeybindingsTabPlugin extends Plugin {
  onload(): void {
    this.addSettingTab({
      id: 'core.keybindings',
      title: 'Keybindings',
      titleKey: 'settings.keybindings.tab_title',
      // 商店 40 / 插件 50,快捷键 60 排在它们后面
      priority: 60,
      icon: createElement(KeybindingsIcon),
      render: KeybindingsTab,
    });
  }
}
