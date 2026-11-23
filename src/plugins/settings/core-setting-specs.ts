// 内置设置项的 spec 单一来源:内置插件用它注册(addSettingItem),业务组件以
// useSettingValue(SPEC.id, SPEC.default) 订阅(值类型由 default 推出)。
// 此前 id 字符串与值类型在注册处与各消费处各写一遍(如 autoSave.markdown.enabled 三处),id 拼错只会让
// useSettingValue 静默回退默认值 —— 关窗脏计数与 autosave 对「是否自动保存」的判断随之分叉。
// 纯数据模块(只 import type),组件引用它不会把插件运行时带进来。

import type { SettingItemSpec, SettingItemValue } from '../registries/SettingItemRegistry';

/** 带值类型的内置设置项 spec(default 的类型即消费方拿到的值类型)。 */
export type CoreSettingSpec<T extends SettingItemValue> = SettingItemSpec & { readonly default: T };

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

export const EDITOR_FONT_SIZE: CoreSettingSpec<number> = {
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
};

export const EDITOR_LINE_NUMBERS: CoreSettingSpec<boolean> = {
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
};

export const AUTO_SAVE_MARKDOWN_ENABLED: CoreSettingSpec<boolean> = {
  id: 'autoSave.markdown.enabled',
  category: 'editor',
  group: 'autosave',
  groupKey: 'settings.group.autosave',
  title: 'Auto-save Markdown',
  titleKey: 'settings.editor.auto_save_markdown',
  // Copy must explain that Source writes raw input, while Edit uses Milkdown.
  descriptionKey: 'settings.editor.auto_save_markdown.desc',
  type: 'boolean',
  default: true,
  priority: 10,
};

export const AUTO_SAVE_DELAY_MS: CoreSettingSpec<number> = {
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
};

export const TERMINAL_FONT_SIZE: CoreSettingSpec<number> = {
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
};

export const TERMINAL_CURSOR_STYLE: CoreSettingSpec<TerminalCursorStyle> = {
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
};

export const EXPLORER_SHOW_HIDDEN_FILES: CoreSettingSpec<boolean> = {
  id: 'explorer.showHiddenFiles',
  category: 'explorer',
  title: 'Show hidden files',
  titleKey: 'settings.explorer.show_hidden_files',
  descriptionKey: 'settings.explorer.show_hidden_files.desc',
  type: 'boolean',
  default: false,
  priority: 1,
};

export const EXPLORER_INDENT_SIZE: CoreSettingSpec<number> = {
  id: 'explorer.indentSize',
  category: 'explorer',
  title: 'Indent width',
  titleKey: 'settings.explorer.indent_width',
  descriptionKey: 'settings.explorer.indent_width.desc',
  type: 'number',
  default: 16,
  min: 8,
  max: 32,
  step: 2,
  unit: 'px',
  priority: 2,
};
