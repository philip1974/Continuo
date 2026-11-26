// 内置设置项的 spec 单一来源:内置插件用它注册(addSettingItem),业务组件以
// useSettingValue(SPEC.id, SPEC.default) 订阅(值类型由 default 推出)。
// 此前 id 字符串与值类型在注册处与各消费处各写一遍(如 autoSave.markdown.enabled 三处),id 拼错只会让
// useSettingValue 静默回退默认值 —— 关窗脏计数与 autosave 对「是否自动保存」的判断随之分叉。
// 纯数据模块(只 import type),组件引用它不会把插件运行时带进来。

import type { SettingItemSpec, SettingItemValue } from '../registries/SettingItemRegistry';
import type { ThemeMode } from '@/theme/ThemeProvider';
import type { Locale } from '../../../electron/shared/i18n-types';

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

// VSCode explorer.confirmDelete(默认开):移到废纸篓前确认。
export const EXPLORER_CONFIRM_DELETE: CoreSettingSpec<boolean> = {
  id: 'explorer.confirmDelete',
  category: 'explorer',
  title: 'Confirm delete',
  titleKey: 'settings.explorer.confirm_delete',
  descriptionKey: 'settings.explorer.confirm_delete.desc',
  type: 'boolean',
  default: true,
  priority: 3,
};

// VSCode explorer.confirmDragAndDrop(默认开):资源管理器内拖动移动文件 / 文件夹前确认;确认框「不再询问」把它写成 false。
export const EXPLORER_CONFIRM_DRAG_AND_DROP: CoreSettingSpec<boolean> = {
  id: 'explorer.confirmDragAndDrop',
  category: 'explorer',
  title: 'Confirm drag and drop',
  titleKey: 'settings.explorer.confirm_drag_and_drop',
  descriptionKey: 'settings.explorer.confirm_drag_and_drop.desc',
  type: 'boolean',
  default: true,
  priority: 3,
};

// VSCode explorer.autoReveal(默认开):活动编辑器切换时资源管理器选中并展开到该文件、滚动入视野(不抢焦点)。
export const EXPLORER_AUTO_REVEAL: CoreSettingSpec<boolean> = {
  id: 'explorer.autoReveal',
  category: 'explorer',
  title: 'Reveal active file',
  titleKey: 'settings.explorer.auto_reveal',
  descriptionKey: 'settings.explorer.auto_reveal.desc',
  type: 'boolean',
  default: true,
  priority: 4,
};

// ── 通用(general)────────────────────────────────────────────────────────────

// Record<ThemeMode, …>:新增主题模式漏配选项即编译报错。
const THEME_OPTION_LABELS: Record<ThemeMode, { label: string; labelKey: string }> = {
  light: { label: 'Light', labelKey: 'settings.general.theme.light' },
  dark: { label: 'Dark', labelKey: 'settings.general.theme.dark' },
  system: { label: 'System', labelKey: 'settings.general.theme.system' },
};

/** 主题(ThemeProvider 直接以本值为唯一存储)。 */
export const GENERAL_THEME: CoreSettingSpec<ThemeMode> = {
  id: 'general.theme',
  category: 'general',
  title: 'Theme',
  titleKey: 'settings.general.theme.title',
  descriptionKey: 'settings.general.theme.description',
  type: 'select',
  default: 'dark',
  enum: (Object.keys(THEME_OPTION_LABELS) as ThemeMode[]).map((value) => ({
    value,
    ...THEME_OPTION_LABELS[value],
  })),
  priority: 1,
};

// 选项文案是该语言的自称(用户看到「中文」而非「Chinese」),不走 i18n。Record<Locale, …>:新增 locale
// 漏配即编译报错(枚举随 electron/shared/i18n-types 的 LOCALES 走,不再手抄)。
const LOCALE_SELF_NAMES: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
  ko: '한국어',
};

/** 界面语言(main settings.json 为权威,LanguageFromSettings 双向桥接)。default 'en' 仅为未注入系统语言时的兜底。 */
export const GENERAL_LANGUAGE: CoreSettingSpec<Locale> = {
  id: 'general.language',
  category: 'general',
  title: 'Language',
  titleKey: 'settings.general.language.title',
  description: "Choose Continuo's UI language. Changes take effect immediately.",
  descriptionKey: 'settings.general.language.description',
  type: 'select',
  default: 'en',
  enum: (Object.keys(LOCALE_SELF_NAMES) as Locale[]).map((value) => ({
    value,
    label: LOCALE_SELF_NAMES[value],
  })),
  priority: 2,
};

// VSCode window.restoreWindows(默认 all):重启时恢复上次退出时开着的全部主窗口(各自的工作区 / 布局 / 几何);关掉只恢复一个
//(上次最后活动的窗口)。权威值在 main(explorer.json restoreAllWindowsOnLaunch,启动恢复在任何 renderer 之前读),
// RestoreWindowsFromSettings 把本值推给 main。
export const GENERAL_RESTORE_WINDOWS: CoreSettingSpec<boolean> = {
  id: 'window.restoreWindows',
  category: 'general',
  title: 'Restore all windows on launch',
  titleKey: 'settings.general.restore_windows',
  descriptionKey: 'settings.general.restore_windows.desc',
  type: 'boolean',
  default: true,
  priority: 3,
};

/** 注册用的语言项:默认值 = main 的系统默认 locale(与首启默认一致),「已修改」/「恢复默认」都以它为准。 */
export function languageSettingSpec(systemDefault: Locale): CoreSettingSpec<Locale> {
  return { ...GENERAL_LANGUAGE, default: systemDefault };
}
