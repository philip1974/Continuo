// 内置设置项的 spec 单一来源:内置插件用它注册(addSettingItem),业务组件以
// useSettingValue(SPEC.id, SPEC.default) 订阅(值类型由 default 推出)。
// 此前 id 字符串与值类型在注册处与各消费处各写一遍(如 autoSave.markdown.enabled 三处),id 拼错只会让
// useSettingValue 静默回退默认值 —— 关窗脏计数与 autosave 对「是否自动保存」的判断随之分叉。
// 纯数据模块(只 import type),组件引用它不会把插件运行时带进来。

import type { SettingItemSpec, SettingItemValue } from '../registries/SettingItemRegistry';
import type { ThemeMode } from '@/theme/ThemeProvider';
import type { Locale } from '../../../electron/shared/i18n-types';
import { DEFAULT_ZOOM_LEVEL, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL } from '../../../electron/shared/window-zoom';

/** 带值类型的内置设置项 spec(default 的类型即消费方拿到的值类型)。 */
export type CoreSettingSpec<T extends SettingItemValue> = SettingItemSpec & { readonly default: T };

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

/**
 * 编辑器字体族(VSCode editor.fontFamily):代码编辑器、Markdown 源码模式与 Markdown 编辑 / 预览里的代码(代码块、行内代码;
 * VSCode Markdown 预览代码同取编辑器字体)。默认值 = 设计 token --wm-font-mono(规范守护两者一致);空串 / 全空白回落默认。
 * 终端字体留空时跟随它(terminal.integrated.fontFamily)。经 EditorFontFromSettings 写到各窗口 <html> 的 CSS 变量。
 * BDD: src/__tests__/font-settings/
 */
export const DEFAULT_EDITOR_FONT_FAMILY = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

export const EDITOR_FONT_FAMILY: CoreSettingSpec<string> = {
  id: 'editor.fontFamily',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Font family',
  titleKey: 'settings.editor.font_family',
  descriptionKey: 'settings.editor.font_family.desc',
  type: 'text',
  default: DEFAULT_EDITOR_FONT_FAMILY,
  priority: 0,
};

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

/**
 * 编辑器行高(VSCode editor.lineHeight,范围 0..150):0 = 按字号自动;0 < 值 < 8 = 字号的倍数;≥ 8 = 像素。换算后取整、
 * 不低于 8px(VSCode fontInfo 同规则)。作用于代码编辑器与 Markdown 源码模式。BDD: src/__tests__/font-settings/
 */
export const EDITOR_LINE_HEIGHT: CoreSettingSpec<number> = {
  id: 'editor.lineHeight',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Line height',
  titleKey: 'settings.editor.line_height',
  descriptionKey: 'settings.editor.line_height.desc',
  type: 'number',
  default: 0,
  min: 0,
  max: 150,
  step: 0.1,
  priority: 1.5,
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

/**
 * 代码编辑器自动换行(VSCode editor.wordWrap 的 off / on 两档;CodeMirror EditorView.lineWrapping)。切换自动换行命令
 *(⌥Z)翻转它。BDD: src/__tests__/workbench-missing-commands/
 */
export const EDITOR_WORD_WRAP: CoreSettingSpec<boolean> = {
  id: 'editor.wordWrap',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Word wrap',
  titleKey: 'settings.editor.word_wrap',
  descriptionKey: 'settings.editor.word_wrap.desc',
  type: 'boolean',
  default: false,
  priority: 3,
};

/**
 * 滚动超过最后一行(VSCode editor.scrollBeyondLastLine,默认开):代码编辑器与 Markdown 源码模式可以把最后一行滚到顶部(CodeMirror
 * scrollPastEnd;VSCode 对 Markdown 无语言级覆盖)。BDD: src/__tests__/editor-scroll-beyond-last-line/
 */
export const EDITOR_SCROLL_BEYOND_LAST_LINE: CoreSettingSpec<boolean> = {
  id: 'editor.scrollBeyondLastLine',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Scroll beyond last line',
  titleKey: 'settings.editor.scroll_beyond_last_line',
  descriptionKey: 'settings.editor.scroll_beyond_last_line.desc',
  type: 'boolean',
  default: true,
  priority: 3.5,
};

/**
 * 缩进参考线(VSCode editor.guides.indentation,默认开;当前块那一条高亮同 editor.guides.highlightActiveIndentation 默认):代码编辑器与
 * Markdown 源码模式(VSCode 对 Markdown 无语言级覆盖)。BDD: src/__tests__/editor-indent-guides/
 */
export const EDITOR_GUIDES_INDENTATION: CoreSettingSpec<boolean> = {
  id: 'editor.guides.indentation',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Indentation guides',
  titleKey: 'settings.editor.guides_indentation',
  descriptionKey: 'settings.editor.guides_indentation.desc',
  type: 'boolean',
  default: true,
  priority: 3.6,
};

export type EditorOccurrencesHighlight = 'off' | 'singleFile';

/**
 * 光标处单词的其它出现处高亮(VSCode editor.occurrencesHighlight,默认 singleFile;VSCode 另有实验性的 multiFile 跨文件高亮,
 * 这里不提供)。BDD: src/__tests__/editor-occurrences-highlight/
 */
export const EDITOR_OCCURRENCES_HIGHLIGHT: CoreSettingSpec<EditorOccurrencesHighlight> = {
  id: 'editor.occurrencesHighlight',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Occurrences highlight',
  titleKey: 'settings.editor.occurrences_highlight',
  descriptionKey: 'settings.editor.occurrences_highlight.desc',
  type: 'select',
  default: 'singleFile',
  enum: [
    { value: 'off', label: 'Off', labelKey: 'settings.editor.occurrences_highlight.off' },
    { value: 'singleFile', label: 'Current file', labelKey: 'settings.editor.occurrences_highlight.single_file' },
  ],
  priority: 3.7,
};

/**
 * 缩进(VSCode editor.tabSize / editor.insertSpaces / editor.detectIndentation,默认 4 / 开 / 开):打开文档时的缩进默认值;
 * 检测开着时按内容推断(推断不出用默认值)。Makefile / Go 默认用 tab(VSCode 内置语言默认)。改设置 → 已打开文档即时按新设置重定。
 * BDD: src/__tests__/editor-indentation/
 */
export const EDITOR_TAB_SIZE: CoreSettingSpec<number> = {
  id: 'editor.tabSize',
  category: 'editor',
  group: 'indentation',
  groupKey: 'settings.group.indentation',
  title: 'Tab size',
  titleKey: 'settings.editor.tab_size',
  descriptionKey: 'settings.editor.tab_size.desc',
  type: 'number',
  default: 4,
  min: 1,
  max: 100,
  step: 1,
  priority: 4,
};

export const EDITOR_INSERT_SPACES: CoreSettingSpec<boolean> = {
  id: 'editor.insertSpaces',
  category: 'editor',
  group: 'indentation',
  groupKey: 'settings.group.indentation',
  title: 'Insert spaces',
  titleKey: 'settings.editor.insert_spaces',
  descriptionKey: 'settings.editor.insert_spaces.desc',
  type: 'boolean',
  default: true,
  priority: 5,
};

export const EDITOR_DETECT_INDENTATION: CoreSettingSpec<boolean> = {
  id: 'editor.detectIndentation',
  category: 'editor',
  group: 'indentation',
  groupKey: 'settings.group.indentation',
  title: 'Detect indentation',
  titleKey: 'settings.editor.detect_indentation',
  descriptionKey: 'settings.editor.detect_indentation.desc',
  type: 'boolean',
  default: true,
  priority: 6,
};

/**
 * 预览编辑器(VSCode workbench.editor.enablePreview,默认开):资源管理器 / 搜索结果单击以预览方式打开(斜体标题,被下一次预览
 * 原位替换,编辑 / 保存 / 双击 / 保留编辑器命令后常驻)。关闭 → 所有打开方式都常驻,已有的预览 tab 一并转常驻。
 * BDD: src/__tests__/editor-preview-tab/
 */
export const EDITOR_ENABLE_PREVIEW: CoreSettingSpec<boolean> = {
  id: 'workbench.editor.enablePreview',
  category: 'editor',
  group: 'tabs',
  groupKey: 'settings.group.tabs',
  title: 'Enable preview editors',
  titleKey: 'settings.editor.enable_preview',
  descriptionKey: 'settings.editor.enable_preview.desc',
  type: 'boolean',
  default: true,
  priority: 20,
};

/**
 * 编辑器 tab 的 git 状态装饰(VSCode workbench.editor.decorations.colors / badges,默认都开 —— VSCode
 * DEFAULT_EDITOR_PART_OPTIONS.decorations = { badges: true, colors: true }):标题按状态着色 / 标题后显示状态字母。
 * 两者都关时 tab 栏不查询 git。BDD: src/__tests__/editor-search-git-decorations/
 */
export const EDITOR_DECORATIONS_COLORS: CoreSettingSpec<boolean> = {
  id: 'workbench.editor.decorations.colors',
  category: 'editor',
  group: 'tabs',
  groupKey: 'settings.group.tabs',
  title: 'Decoration colors',
  titleKey: 'settings.editor.decorations_colors',
  descriptionKey: 'settings.editor.decorations_colors.desc',
  type: 'boolean',
  default: true,
  priority: 21,
};

export const EDITOR_DECORATIONS_BADGES: CoreSettingSpec<boolean> = {
  id: 'workbench.editor.decorations.badges',
  category: 'editor',
  group: 'tabs',
  groupKey: 'settings.group.tabs',
  title: 'Decoration badges',
  titleKey: 'settings.editor.decorations_badges',
  descriptionKey: 'settings.editor.decorations_badges.desc',
  type: 'boolean',
  default: true,
  priority: 22,
};

/** files.autoSave 的取值(VSCode 同名同义)。 */
export const FILES_AUTO_SAVE_MODES = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'] as const;
export type FilesAutoSaveMode = (typeof FILES_AUTO_SAVE_MODES)[number];

/**
 * 自动保存(VSCode files.autoSave,桌面版默认 off):afterDelay = 停手 files.autoSaveDelay 后;onFocusChange = 编辑器失焦时;
 * onWindowChange = 窗口失焦时。Markdown 另有语言级覆盖 AUTO_SAVE_MARKDOWN_ENABLED(默认开,不看本项)。
 * BDD: src/__tests__/files-auto-save/
 */
export const FILES_AUTO_SAVE: CoreSettingSpec<FilesAutoSaveMode> = {
  id: 'files.autoSave',
  category: 'editor',
  group: 'autosave',
  groupKey: 'settings.group.autosave',
  title: 'Auto save',
  titleKey: 'settings.editor.files_auto_save',
  descriptionKey: 'settings.editor.files_auto_save.desc',
  type: 'select',
  default: 'off',
  enum: [
    { value: 'off', label: 'Off', labelKey: 'settings.editor.files_auto_save.off' },
    { value: 'afterDelay', label: 'After delay', labelKey: 'settings.editor.files_auto_save.after_delay' },
    { value: 'onFocusChange', label: 'On focus change', labelKey: 'settings.editor.files_auto_save.on_focus_change' },
    { value: 'onWindowChange', label: 'On window change', labelKey: 'settings.editor.files_auto_save.on_window_change' },
  ],
  priority: 8,
};

/** files.autoSave = afterDelay 的延迟(VSCode files.autoSaveDelay,默认 1000;这里夹取到 100–60000)。 */
export const FILES_AUTO_SAVE_DELAY: CoreSettingSpec<number> = {
  id: 'files.autoSaveDelay',
  category: 'editor',
  group: 'autosave',
  groupKey: 'settings.group.autosave',
  title: 'Auto save delay',
  titleKey: 'settings.editor.files_auto_save_delay',
  descriptionKey: 'settings.editor.files_auto_save_delay.desc',
  type: 'number',
  default: 1000,
  min: 100,
  max: 60_000,
  step: 100,
  unit: 'ms',
  priority: 9,
};

/**
 * Markdown 的语言级覆盖(相当于 VSCode `"[markdown]": { "files.autoSave": "afterDelay", "files.autoSaveDelay": 2000 }`):
 * 开 → Markdown 总在停手 AUTO_SAVE_DELAY_MS 后自动保存;关 → 跟随 files.autoSave。沿用旧 id,已保存的值不丢。
 */
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

/**
 * 终端字体族(VSCode terminal.integrated.fontFamily):空 = 跟随 editor.fontFamily(编辑器字体也是默认值时用终端自带的
 * Nerd Font 回退链,保住 Powerline / 图标字形);填写的字体后面仍接 Nerd Font 符号回退与 monospace(VSCode 同样总接 monospace)。
 * BDD: src/__tests__/font-settings/
 */
export const TERMINAL_FONT_FAMILY: CoreSettingSpec<string> = {
  id: 'terminal.integrated.fontFamily',
  category: 'terminal',
  title: 'Font family',
  titleKey: 'settings.terminal.font_family',
  descriptionKey: 'settings.terminal.font_family.desc',
  type: 'text',
  default: '',
  priority: 0,
};

/** 终端行高(VSCode terminal.integrated.lineHeight):字号的倍数,默认 1,不小于 1。BDD: src/__tests__/font-settings/ */
export const TERMINAL_LINE_HEIGHT: CoreSettingSpec<number> = {
  id: 'terminal.integrated.lineHeight',
  category: 'terminal',
  title: 'Line height',
  titleKey: 'settings.terminal.line_height',
  descriptionKey: 'settings.terminal.line_height.desc',
  type: 'number',
  default: 1,
  min: 1,
  max: 10,
  step: 0.1,
  priority: 1.5,
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

// VSCode 默认显示点文件(.gitignore / .env / .github …),只按 files.exclude 排除版本库元数据等;这里固定排除集即
// fs:list-dir 默认 exclude(LIST_DIR_DEFAULT_EXCLUDE:.git / .svn / .hg / CVS / .DS_Store / Thumbs.db,另含 node_modules)。
// 关掉 = 额外隐藏全部 . 开头的项。只存 override:之前显式设为 false 的用户保留该选择。
export const EXPLORER_SHOW_HIDDEN_FILES: CoreSettingSpec<boolean> = {
  id: 'explorer.showHiddenFiles',
  category: 'explorer',
  title: 'Show hidden files',
  titleKey: 'settings.explorer.show_hidden_files',
  descriptionKey: 'settings.explorer.show_hidden_files.desc',
  type: 'boolean',
  default: true,
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

// VSCode explorer.decorations.colors / explorer.decorations.badges(默认开):文件名按 git 状态着色 / 右侧显示状态字母。
// 两者都关时不再查询 git。BDD: src/__tests__/explorer-git-decorations/
export const EXPLORER_DECORATIONS_COLORS: CoreSettingSpec<boolean> = {
  id: 'explorer.decorations.colors',
  category: 'explorer',
  title: 'Decoration colors',
  titleKey: 'settings.explorer.decorations_colors',
  descriptionKey: 'settings.explorer.decorations_colors.desc',
  type: 'boolean',
  default: true,
  priority: 5,
};

export const EXPLORER_DECORATIONS_BADGES: CoreSettingSpec<boolean> = {
  id: 'explorer.decorations.badges',
  category: 'explorer',
  title: 'Decoration badges',
  titleKey: 'settings.explorer.decorations_badges',
  descriptionKey: 'settings.explorer.decorations_badges.desc',
  type: 'boolean',
  default: true,
  priority: 6,
};

// VSCode search.decorations.colors / search.decorations.badges(默认开):搜索结果文件名按 git 状态着色 / 显示状态字母。
// Continuo 无单独的搜索设置页,放在资源管理器设置页的「搜索」组。两者都关时搜索视图不查询 git。
// BDD: src/__tests__/editor-search-git-decorations/
export const SEARCH_DECORATIONS_COLORS: CoreSettingSpec<boolean> = {
  id: 'search.decorations.colors',
  category: 'explorer',
  group: 'search',
  groupKey: 'settings.group.search',
  title: 'Search decoration colors',
  titleKey: 'settings.search.decorations_colors',
  descriptionKey: 'settings.search.decorations_colors.desc',
  type: 'boolean',
  default: true,
  priority: 20,
};

export const SEARCH_DECORATIONS_BADGES: CoreSettingSpec<boolean> = {
  id: 'search.decorations.badges',
  category: 'explorer',
  group: 'search',
  groupKey: 'settings.group.search',
  title: 'Search decoration badges',
  titleKey: 'settings.search.decorations_badges',
  descriptionKey: 'settings.search.decorations_badges.desc',
  type: 'boolean',
  default: true,
  priority: 21,
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

/**
 * 缩放级别(VSCode window.zoomLevel,默认 0,范围 -8..8,每级 ±20%,可填小数):作用于所有窗口(主窗、新窗口、popout 子窗),
 * 重启后保持。放大 / 缩小 / 重置缩放命令改的就是它(VSCode window.zoomPerWindow=false 的语义);ZoomLevelFromSettings 推给 main
 * 套用并缓存(冷启动首窗即用)。BDD: src/__tests__/window-zoom/
 */
export const WINDOW_ZOOM_LEVEL: CoreSettingSpec<number> = {
  id: 'window.zoomLevel',
  category: 'general',
  title: 'Zoom level',
  titleKey: 'settings.general.zoom_level',
  descriptionKey: 'settings.general.zoom_level.desc',
  type: 'number',
  default: DEFAULT_ZOOM_LEVEL,
  min: MIN_ZOOM_LEVEL,
  max: MAX_ZOOM_LEVEL,
  step: 1,
  priority: 4,
};

/** 读屏优化模式(VSCode editor.accessibilitySupport 同名同取值,默认 auto)。 */
export type AccessibilitySupport = 'auto' | 'on' | 'off';

/**
 * 读屏优化(VSCode editor.accessibilitySupport):auto = 按系统检测到的辅助技术(读屏)自动开启;on = 始终按读屏优化;
 * off = 假定未接读屏。当前作用于终端(xterm screenReaderMode:输出进可访问 DOM 树供读屏朗读),所有已开终端即时生效。
 * BDD: src/__tests__/terminal-screen-reader/
 */
export const EDITOR_ACCESSIBILITY_SUPPORT: CoreSettingSpec<AccessibilitySupport> = {
  id: 'editor.accessibilitySupport',
  category: 'general',
  title: 'Accessibility support',
  titleKey: 'settings.general.accessibility_support',
  descriptionKey: 'settings.general.accessibility_support.desc',
  type: 'select',
  default: 'auto',
  enum: [
    { value: 'auto', label: 'Auto', labelKey: 'settings.general.accessibility_support.auto' },
    { value: 'on', label: 'On', labelKey: 'settings.general.accessibility_support.on' },
    { value: 'off', label: 'Off', labelKey: 'settings.general.accessibility_support.off' },
  ],
  priority: 5,
};

/** 注册用的语言项:默认值 = main 的系统默认 locale(与首启默认一致),「已修改」/「恢复默认」都以它为准。 */
export function languageSettingSpec(systemDefault: Locale): CoreSettingSpec<Locale> {
  return { ...GENERAL_LANGUAGE, default: systemDefault };
}
