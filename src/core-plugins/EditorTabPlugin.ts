// 内置「编辑器」SettingTab + 编辑器类设置项(M-Settings v6)。
// 复用 CategoryTabContent 渲染 category='editor';items 由本 plugin 注册,
// 业务侧组件通过 useSettingValue 订阅各项实时变化。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { CategoryTabContent } from '@/plugins/settings/CategoryTabContent';
import { EditorIcon } from '@/plugins/settings/tab-icons';

export default class EditorTabPlugin extends Plugin {
  onload(): void {
    // priority 10:排在「通用(1)」后,「插件商店(40)」前
    this.addSettingTab({
      id: 'core.editor',
      title: 'Editor',
      titleKey: 'settings.editor.tab_title',
      priority: 10,
      icon: createElement(EditorIcon),
      render: () => createElement(CategoryTabContent, { category: 'editor' }),
    });

    // ── 外观 ──
    this.addSettingItem({
      id: 'editor.fontSize',
      category: 'editor',
      group: '外观',
      title: 'Font size',
      titleKey: 'settings.editor.font_size',
      description: 'CodeEditor(代码 / Source mode)的字号。',
      type: 'number',
      default: 13,
      min: 10,
      max: 28,
      step: 1,
      unit: 'px',
      priority: 1,
    });
    this.addSettingItem({
      id: 'editor.lineNumbers',
      category: 'editor',
      group: '外观',
      title: 'Show line numbers',
      titleKey: 'settings.editor.show_line_numbers',
      description: 'CodeEditor 是否显示行号(同时控制代码折叠 marker)。',
      type: 'boolean',
      default: true,
      priority: 2,
    });

    // ── 自动保存 ──
    this.addSettingItem({
      id: 'autoSave.markdown.enabled',
      category: 'editor',
      group: '自动保存',
      title: 'Auto-save Markdown',
      titleKey: 'settings.editor.auto_save_markdown',
      description: '关闭后 Markdown 也需 ⌘S 显式保存。代码文件不自动保存。',
      type: 'boolean',
      default: true,
      priority: 10,
    });
    this.addSettingItem({
      id: 'autoSave.delayMs',
      category: 'editor',
      group: '自动保存',
      title: 'Auto-save delay',
      titleKey: 'settings.editor.auto_save_delay',
      description: '停止输入多久后触发自动保存。',
      type: 'number',
      default: 2000,
      min: 500,
      max: 10000,
      step: 100,
      unit: 'ms',
      priority: 11,
    });
  }
}
