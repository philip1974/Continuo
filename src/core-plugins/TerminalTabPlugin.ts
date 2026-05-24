// 内置「终端」SettingTab + Terminal 类设置项(M-Settings v6)。
// useTerminal 通过 useSettingValue 订阅这些项实时生效。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { CategoryTabContent } from '@/plugins/settings/CategoryTabContent';
import { TerminalIcon } from '@/plugins/settings/tab-icons';

export default class TerminalTabPlugin extends Plugin {
  onload(): void {
    // priority 30:排在通用 / 编辑器 / 资源管理器之后,插件商店之前
    this.addSettingTab({
      id: 'core.terminal',
      title: 'Terminal',
      titleKey: 'settings.terminal.tab_title',
      priority: 30,
      icon: createElement(TerminalIcon),
      render: () =>
        createElement(CategoryTabContent, { category: 'terminal' }),
    });

    this.addSettingItem({
      id: 'terminal.fontSize',
      category: 'terminal',
      title: 'Font size',
      titleKey: 'settings.terminal.font_size',
      descriptionKey: 'settings.terminal.font_size.desc',
      type: 'number',
      default: 13,
      min: 10,
      max: 24,
      step: 1,
      unit: 'px',
      priority: 1,
    });

    this.addSettingItem({
      id: 'terminal.cursorStyle',
      category: 'terminal',
      title: 'Cursor style',
      titleKey: 'settings.terminal.cursor_style',
      type: 'select',
      default: 'block',
      enum: [
        { value: 'block', label: 'Block', labelKey: 'settings.terminal.cursor_style.block' },
        { value: 'underline', label: 'Underline', labelKey: 'settings.terminal.cursor_style.underline' },
        { value: 'bar', label: 'Bar', labelKey: 'settings.terminal.cursor_style.bar' },
      ],
      priority: 2,
    });
  }
}
