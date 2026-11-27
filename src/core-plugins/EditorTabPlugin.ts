// 内置「编辑器」SettingTab + 编辑器类设置项(M-Settings v6)。
// 复用 CategoryTabContent 渲染 category='editor';items 由本 plugin 注册,
// 业务侧组件通过 useSettingValue 订阅各项实时变化。

import { createElement } from 'react';
import { Plugin } from '@/plugins/Plugin';
import {
  AUTO_SAVE_DELAY_MS,
  AUTO_SAVE_MARKDOWN_ENABLED,
  EDITOR_DECORATIONS_BADGES,
  EDITOR_DECORATIONS_COLORS,
  EDITOR_DETECT_INDENTATION,
  EDITOR_ENABLE_PREVIEW,
  EDITOR_INSERT_SPACES,
  EDITOR_TAB_SIZE,
  EDITOR_FONT_FAMILY,
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
  EDITOR_LINE_NUMBERS,
  EDITOR_SCROLL_BEYOND_LAST_LINE,
  EDITOR_GUIDES_INDENTATION,
  EDITOR_OCCURRENCES_HIGHLIGHT,
  EDITOR_WORD_WRAP,
  FILES_AUTO_SAVE,
  FILES_AUTO_SAVE_DELAY,
} from '@/plugins/settings/core-setting-specs';
import { renderCategoryTab } from './lazy-category-tab';
import { EditorIcon } from '@/plugins/settings/tab-icons';

export default class EditorTabPlugin extends Plugin {
  onload(): void {
    // priority 10:排在「通用(1)」后,「插件市场(40)」前
    this.addSettingTab({
      id: 'core.editor',
      title: 'Editor',
      titleKey: 'settings.editor.tab_title',
      priority: 10,
      icon: createElement(EditorIcon),
      render: () => renderCategoryTab('editor'),
    });

    // ── Appearance ──
    this.addSettingItem(EDITOR_FONT_FAMILY);
    this.addSettingItem(EDITOR_FONT_SIZE);
    this.addSettingItem(EDITOR_LINE_HEIGHT);
    this.addSettingItem(EDITOR_LINE_NUMBERS);
    this.addSettingItem(EDITOR_WORD_WRAP);
    this.addSettingItem(EDITOR_SCROLL_BEYOND_LAST_LINE);
    this.addSettingItem(EDITOR_GUIDES_INDENTATION);
    this.addSettingItem(EDITOR_OCCURRENCES_HIGHLIGHT);

    // ── Indentation(BDD: src/__tests__/editor-indentation/)──
    this.addSettingItem(EDITOR_TAB_SIZE);
    this.addSettingItem(EDITOR_INSERT_SPACES);
    this.addSettingItem(EDITOR_DETECT_INDENTATION);

    // ── Auto-save ──(files.autoSave / files.autoSaveDelay + Markdown 语言级覆盖;BDD: src/__tests__/files-auto-save/)
    this.addSettingItem(FILES_AUTO_SAVE);
    this.addSettingItem(FILES_AUTO_SAVE_DELAY);
    this.addSettingItem(AUTO_SAVE_MARKDOWN_ENABLED);
    this.addSettingItem(AUTO_SAVE_DELAY_MS);

    // ── Tabs ──
    this.addSettingItem(EDITOR_ENABLE_PREVIEW);
    this.addSettingItem(EDITOR_DECORATIONS_COLORS);
    this.addSettingItem(EDITOR_DECORATIONS_BADGES);
  }
}
