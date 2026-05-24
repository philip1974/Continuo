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

    // ── Appearance ──
    this.addSettingItem({
      id: 'editor.fontSize',
      category: 'editor',
      group: 'appearance',
      groupKey: 'settings.group.appearance',
      title: 'Font size',
      titleKey: 'settings.editor.font_size',
      descriptionKey: 'settings.editor.font_size.desc',
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
      group: 'appearance',
      groupKey: 'settings.group.appearance',
      title: 'Show line numbers',
      titleKey: 'settings.editor.show_line_numbers',
      descriptionKey: 'settings.editor.show_line_numbers.desc',
      type: 'boolean',
      default: true,
      priority: 2,
    });

    // ── Auto-save ──
    this.addSettingItem({
      id: 'autoSave.markdown.enabled',
      category: 'editor',
      group: 'autosave',
      groupKey: 'settings.group.autosave',
      title: 'Auto-save Markdown',
      titleKey: 'settings.editor.auto_save_markdown',
      descriptionKey: 'settings.editor.auto_save_markdown.desc',
      type: 'boolean',
      default: true,
      priority: 10,
    });
    this.addSettingItem({
      id: 'autoSave.delayMs',
      category: 'editor',
      group: 'autosave',
      groupKey: 'settings.group.autosave',
      title: 'Auto-save delay',
      titleKey: 'settings.editor.auto_save_delay',
      descriptionKey: 'settings.editor.auto_save_delay.desc',
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
