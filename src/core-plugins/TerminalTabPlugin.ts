// 内置「终端」SettingTab + Terminal 类设置项(M-Settings v6)。
// useTerminal 通过 useSettingValue 订阅这些项实时生效。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import {
  TERMINAL_CURSOR_STYLE,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
} from '@/plugins/settings/core-setting-specs';
import { renderCategoryTab } from './lazy-category-tab';
import { TerminalIcon } from '@/plugins/settings/tab-icons';

export default class TerminalTabPlugin extends Plugin {
  onload(): void {
    // priority 30:排在通用 / 编辑器 / 资源管理器之后,插件市场之前
    this.addSettingTab({
      id: 'core.terminal',
      title: 'Terminal',
      titleKey: 'settings.terminal.tab_title',
      priority: 30,
      icon: createElement(TerminalIcon),
      render: () => renderCategoryTab('terminal'),
    });

    this.addSettingItem(TERMINAL_FONT_FAMILY);
    this.addSettingItem(TERMINAL_FONT_SIZE);
    this.addSettingItem(TERMINAL_LINE_HEIGHT);

    this.addSettingItem(TERMINAL_CURSOR_STYLE);
  }
}
