// 内置「终端」SettingTab + Terminal 类设置项(M-Settings v6)。
// useTerminal 通过 useSettingValue 订阅这些项实时生效。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { CategoryTabContent } from '@/plugins/settings/CategoryTabContent';

export default class TerminalTabPlugin extends Plugin {
  onload(): void {
    // priority 30:排在通用 / 编辑器 / 资源管理器之后,插件商店之前
    this.addSettingTab({
      id: 'core.terminal',
      title: '终端',
      priority: 30,
      render: () =>
        createElement(CategoryTabContent, { category: 'terminal' }),
    });

    this.addSettingItem({
      id: 'terminal.fontSize',
      category: 'terminal',
      title: '字号',
      description: 'xterm 字号,单位 px。变化时自动 fit 重排。',
      type: 'number',
      default: 13,
      min: 10,
      max: 24,
      step: 1,
      priority: 1,
    });

    this.addSettingItem({
      id: 'terminal.cursorStyle',
      category: 'terminal',
      title: '光标样式',
      type: 'select',
      default: 'block',
      enum: [
        { value: 'block', label: '块' },
        { value: 'underline', label: '下划线' },
        { value: 'bar', label: '竖线' },
      ],
      priority: 2,
    });
  }
}
