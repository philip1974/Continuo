// 内置设置项的 spec 单一来源:内置插件用它注册(addSettingItem),业务组件以
// useSettingValue(SPEC.id, SPEC.default) 订阅(值类型由 default 推出)。
// 此前 id 字符串与值类型在注册处与各消费处各写一遍(如 autoSave.markdown.enabled 三处),id 拼错只会让
// useSettingValue 静默回退默认值 —— 关窗脏计数与 autosave 对「是否自动保存」的判断随之分叉。
// 纯数据模块(只 import type),组件引用它不会把插件运行时带进来。

import type { SettingItemSpec, SettingItemValue } from '../registries/SettingItemRegistry';
import type { ThemeMode } from '@/theme/ThemeProvider';
import type { Locale } from '../../../electron/shared/i18n-types';
import { DEFAULT_ZOOM_LEVEL, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL } from '../../../electron/shared/window-zoom';
import { osVariantKey } from '@/i18n/translate';

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
  keywordsKey: 'settings.editor.font_size.keywords',
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
  // 不给 step(= HTML step="any",VSCode 非整数设置同款):↑ 一次 0 → 1(字号倍数 1),而不是 0 → 0.1(8px 行高、文字叠在一起)。
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
 * 复制时带语法高亮(VSCode editor.copyWithSyntaxHighlighting,默认开):代码编辑器与 Markdown 源码模式复制时另写一份带内联配色的
 * HTML(粘贴到文档 / 邮件里保留代码颜色);关掉只写纯文本。BDD: src/__tests__/editor-clipboard/
 */
export const EDITOR_COPY_WITH_SYNTAX_HIGHLIGHTING: CoreSettingSpec<boolean> = {
  id: 'editor.copyWithSyntaxHighlighting',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Copy with syntax highlighting',
  titleKey: 'settings.editor.copy_with_syntax_highlighting',
  descriptionKey: 'settings.editor.copy_with_syntax_highlighting.desc',
  type: 'boolean',
  default: true,
  priority: 3.8,
};

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

/** 终端字号(VSCode terminal.integrated.fontSize;旧 id terminal.fontSize 的已存值启动时迁移,见 LEGACY_SETTING_IDS)。 */
export const TERMINAL_FONT_SIZE: CoreSettingSpec<number> = {
  id: 'terminal.integrated.fontSize',
  category: 'terminal',
  title: 'Font size',
  titleKey: 'settings.terminal.font_size',
  descriptionKey: 'settings.terminal.font_size.desc',
  keywordsKey: 'settings.terminal.font_size.keywords',
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
  // 不给 step(step="any",同 editor.lineHeight):↑ / ↓ 一次 ±1,可键入 1.2 这类小数。
  priority: 1.5,
};

/** 终端光标样式(VSCode terminal.integrated.cursorStyle;旧 id terminal.cursorStyle 迁移同上)。 */
export const TERMINAL_CURSOR_STYLE: CoreSettingSpec<TerminalCursorStyle> = {
  id: 'terminal.integrated.cursorStyle',
  category: 'terminal',
  title: 'Cursor style',
  titleKey: 'settings.terminal.cursor_style',
  descriptionKey: 'settings.terminal.cursor_style.desc',
  type: 'select',
  default: 'block',
  enum: [
    { value: 'block', label: 'Block', labelKey: 'settings.terminal.cursor_style.block' },
    { value: 'underline', label: 'Underline', labelKey: 'settings.terminal.cursor_style.underline' },
    { value: 'bar', label: 'Bar', labelKey: 'settings.terminal.cursor_style.bar' },
  ],
  priority: 2,
};

/**
 * 改名前的设置 id → 现 id(对齐 VSCode 的 terminal.integrated.*)。已存的旧 id 值在读设置存储时改记到新 id(新 id 已有值则
 * 以新 id 为准)并删掉旧 id:启动、跨窗口同步、每次读-改-写都经同一迁移(values-store)。
 */
export const LEGACY_SETTING_IDS: Readonly<Record<string, string>> = {
  'terminal.fontSize': TERMINAL_FONT_SIZE.id,
  'terminal.cursorStyle': TERMINAL_CURSOR_STYLE.id,
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
  // Windows「回收站」(VSCode isWindows 选 Recycle Bin 文案)
  descriptionKey: osVariantKey('settings.explorer.confirm_delete.desc'),
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

// VSCode search.useIgnoreFiles(默认开):在文件中查找与 Quick Open(⌘P)遵从 .gitignore / .ignore(工作区内各层,不要求是
// git 仓库;不读工作区之上的)。搜索视图「使用排除设置与忽略文件」关闭时本次搜索不用。BDD: src/__tests__/search-ignore-files/
export const SEARCH_USE_IGNORE_FILES: CoreSettingSpec<boolean> = {
  id: 'search.useIgnoreFiles',
  category: 'explorer',
  group: 'search',
  groupKey: 'settings.group.search',
  title: 'Use ignore files',
  titleKey: 'settings.search.use_ignore_files',
  descriptionKey: 'settings.search.use_ignore_files.desc',
  type: 'boolean',
  default: true,
  priority: 22,
};

// ── 通用(general)────────────────────────────────────────────────────────────

// Record<ThemeMode, …>:新增主题模式漏配选项即编译报错。
const THEME_OPTION_LABELS: Record<ThemeMode, { label: string; labelKey: string }> = {
  light: { label: 'Light', labelKey: 'settings.general.theme.light' },
  dark: { label: 'Dark', labelKey: 'settings.general.theme.dark' },
  // VSCode 内置主题名(extensions/theme-defaults:hcColorThemeLabel / lightHcColorThemeLabel)
  hcDark: { label: 'Dark High Contrast', labelKey: 'settings.general.theme.hc_dark' },
  hcLight: { label: 'Light High Contrast', labelKey: 'settings.general.theme.hc_light' },
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
 * 外链受信域名(VSCode「Manage Trusted Domains」/ workbench.action.manageTrustedDomain 打开的受信域名列表):值不存在设置值
 * store 里 —— 权威值在 main(外链确认由 main 判定、确认框里的「信任 <域名>」由 main 写入),设置页用 TrustedDomainsSettingRow 经
 * IPC 读写。spec 只为让它出现在通用页、可被搜索与 `@id:` 定位。BDD: src/__tests__/external-link-trusted-domains/
 */
export const WORKBENCH_TRUSTED_DOMAINS: CoreSettingSpec<string> = {
  id: 'workbench.trustedDomains',
  category: 'general',
  title: 'Trusted domains',
  titleKey: 'settings.general.trusted_domains',
  descriptionKey: 'settings.general.trusted_domains.desc',
  keywordsKey: 'settings.general.trusted_domains.keywords',
  type: 'text',
  default: '',
  priority: 6,
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
  // 不给 step(step="any",VSCode window.zoomLevel 是非整数 number):1.5 之类的值不算「不合步长」,↑ / ↓ 仍 ±1。
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

// ── 光标(VSCode editor.cursorStyle / cursorWidth / cursorBlinking)──────────────────────────────────────────────────

/** 光标样式(VSCode editor.cursorStyle 同名同取值,默认 line)。 */
export const EDITOR_CURSOR_STYLES = ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'] as const;
export type EditorCursorStyle = (typeof EDITOR_CURSOR_STYLES)[number];

/** 光标闪烁(VSCode editor.cursorBlinking 同名同取值,默认 blink)。 */
export const EDITOR_CURSOR_BLINKINGS = ['blink', 'smooth', 'phase', 'expand', 'solid'] as const;
export type EditorCursorBlinking = (typeof EDITOR_CURSOR_BLINKINGS)[number];

const CURSOR_STYLE_LABELS: Record<EditorCursorStyle, string> = {
  line: 'Line',
  block: 'Block',
  underline: 'Underline',
  'line-thin': 'Line (thin)',
  'block-outline': 'Block outline',
  'underline-thin': 'Underline (thin)',
};

const CURSOR_BLINKING_LABELS: Record<EditorCursorBlinking, string> = {
  blink: 'Blink',
  smooth: 'Smooth',
  phase: 'Phase',
  expand: 'Expand',
  solid: 'Solid',
};

/**
 * 编辑器光标样式(VSCode editor.cursorStyle):作用于代码编辑器、Markdown 源码模式与冲突比较(CodeMirror 自绘光标)。
 * BDD: src/__tests__/editor-cursor-options/
 */
export const EDITOR_CURSOR_STYLE: CoreSettingSpec<EditorCursorStyle> = {
  id: 'editor.cursorStyle',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Cursor style',
  titleKey: 'settings.editor.cursor_style',
  descriptionKey: 'settings.editor.cursor_style.desc',
  type: 'select',
  default: 'line',
  enum: EDITOR_CURSOR_STYLES.map((value) => ({
    value,
    label: CURSOR_STYLE_LABELS[value],
    labelKey: `settings.editor.cursor_style.${value.replace('-', '_')}`,
  })),
  priority: 2.1,
};

/**
 * 线形光标宽度(VSCode editor.cursorWidth,默认 0):0 = 默认 2px(VSCode viewCursor 同);> 0 = 该像素宽,不超过一个字符宽。
 * 只作用于 cursorStyle = line。BDD: src/__tests__/editor-cursor-options/
 */
export const EDITOR_CURSOR_WIDTH: CoreSettingSpec<number> = {
  id: 'editor.cursorWidth',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Cursor width',
  titleKey: 'settings.editor.cursor_width',
  descriptionKey: 'settings.editor.cursor_width.desc',
  type: 'number',
  default: 0,
  min: 0,
  max: 50,
  step: 1,
  unit: 'px',
  priority: 2.2,
};

/** 光标闪烁动画(VSCode editor.cursorBlinking)。BDD: src/__tests__/editor-cursor-options/ */
export const EDITOR_CURSOR_BLINKING: CoreSettingSpec<EditorCursorBlinking> = {
  id: 'editor.cursorBlinking',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Cursor blinking',
  titleKey: 'settings.editor.cursor_blinking',
  descriptionKey: 'settings.editor.cursor_blinking.desc',
  type: 'select',
  default: 'blink',
  enum: EDITOR_CURSOR_BLINKINGS.map((value) => ({
    value,
    label: CURSOR_BLINKING_LABELS[value],
    labelKey: `settings.editor.cursor_blinking.${value}`,
  })),
  priority: 2.3,
};

// ── 字体缩放(VSCode editor.mouseWheelZoom / terminal.integrated.mouseWheelZoom)─────────────────────────────────────

/** 按住 ⌘(Windows / Linux Ctrl)滚动鼠标滚轮缩放编辑器字体(VSCode editor.mouseWheelZoom,默认关)。BDD: src/__tests__/font-zoom/ */
export const EDITOR_MOUSE_WHEEL_ZOOM: CoreSettingSpec<boolean> = {
  id: 'editor.mouseWheelZoom',
  category: 'editor',
  group: 'appearance',
  groupKey: 'settings.group.appearance',
  title: 'Mouse wheel zoom',
  titleKey: 'settings.editor.mouse_wheel_zoom',
  descriptionKey: 'settings.editor.mouse_wheel_zoom.desc',
  type: 'boolean',
  default: false,
  priority: 1.2,
};

/** 按住 ⌘(Windows / Linux Ctrl)滚动鼠标滚轮改终端字号(VSCode terminal.integrated.mouseWheelZoom,默认关)。BDD: src/__tests__/font-zoom/ */
export const TERMINAL_MOUSE_WHEEL_ZOOM: CoreSettingSpec<boolean> = {
  id: 'terminal.integrated.mouseWheelZoom',
  category: 'terminal',
  title: 'Mouse wheel zoom',
  titleKey: 'settings.terminal.mouse_wheel_zoom',
  descriptionKey: 'settings.terminal.mouse_wheel_zoom.desc',
  type: 'boolean',
  default: false,
  priority: 1.2,
};

// ── 工作台布局(VSCode workbench.statusBar.visible / workbench.activityBar.location / workbench.editor.showTabs)──────

/** 显示状态栏(VSCode workbench.statusBar.visible,默认开)。BDD: src/__tests__/workbench-layout-visibility/ */
export const WORKBENCH_STATUS_BAR_VISIBLE: CoreSettingSpec<boolean> = {
  id: 'workbench.statusBar.visible',
  category: 'general',
  title: 'Show status bar',
  titleKey: 'settings.general.status_bar_visible',
  descriptionKey: 'settings.general.status_bar_visible.desc',
  type: 'boolean',
  default: true,
  priority: 7,
};

/** 活动栏位置(VSCode workbench.activityBar.location 的 default / hidden 两档;Continuo 活动栏只在侧边)。 */
export type ActivityBarLocation = 'default' | 'hidden';

/** 活动栏位置 / 隐藏(VSCode workbench.activityBar.location)。BDD: src/__tests__/workbench-layout-visibility/ */
export const WORKBENCH_ACTIVITY_BAR_LOCATION: CoreSettingSpec<ActivityBarLocation> = {
  id: 'workbench.activityBar.location',
  category: 'general',
  title: 'Activity bar',
  titleKey: 'settings.general.activity_bar_location',
  descriptionKey: 'settings.general.activity_bar_location.desc',
  type: 'select',
  default: 'default',
  enum: [
    { value: 'default', label: 'Default', labelKey: 'settings.general.activity_bar_location.default' },
    { value: 'hidden', label: 'Hidden', labelKey: 'settings.general.activity_bar_location.hidden' },
  ],
  priority: 8,
};

/** 编辑器 tab 栏(VSCode workbench.editor.showTabs 的 multiple / none 两档)。 */
export type EditorShowTabs = 'multiple' | 'none';

/** dock 组的 tab 栏显示 / 隐藏(VSCode workbench.editor.showTabs)。BDD: src/__tests__/workbench-layout-visibility/ */
export const WORKBENCH_EDITOR_SHOW_TABS: CoreSettingSpec<EditorShowTabs> = {
  id: 'workbench.editor.showTabs',
  category: 'editor',
  group: 'tabs',
  groupKey: 'settings.group.tabs',
  title: 'Tab bar',
  titleKey: 'settings.editor.show_tabs',
  descriptionKey: 'settings.editor.show_tabs.desc',
  type: 'select',
  default: 'multiple',
  enum: [
    { value: 'multiple', label: 'Multiple tabs', labelKey: 'settings.editor.show_tabs.multiple' },
    { value: 'none', label: 'Hidden', labelKey: 'settings.editor.show_tabs.none' },
  ],
  priority: 19,
};

// ── 屏幕录制模式(VSCode screencastMode.*)──────────────────────────────────────────────────────────────────────────

/** 屏幕录制模式按键浮层的字号(VSCode screencastMode.fontSize,默认 56,20..100)。BDD: src/__tests__/screencast-mode/ */
export const SCREENCAST_FONT_SIZE: CoreSettingSpec<number> = {
  id: 'screencastMode.fontSize',
  category: 'general',
  group: 'screencast',
  groupKey: 'settings.group.screencast',
  title: 'Keyboard overlay font size',
  titleKey: 'settings.screencast.font_size',
  descriptionKey: 'settings.screencast.font_size.desc',
  type: 'number',
  default: 56,
  min: 20,
  max: 100,
  step: 1,
  unit: 'px',
  priority: 20,
};

/** 按键浮层离窗口底部的距离,占窗口高度的百分比(VSCode screencastMode.verticalOffset,默认 20,0..90)。 */
export const SCREENCAST_VERTICAL_OFFSET: CoreSettingSpec<number> = {
  id: 'screencastMode.verticalOffset',
  category: 'general',
  group: 'screencast',
  groupKey: 'settings.group.screencast',
  title: 'Keyboard overlay vertical offset',
  titleKey: 'settings.screencast.vertical_offset',
  descriptionKey: 'settings.screencast.vertical_offset.desc',
  type: 'number',
  default: 20,
  min: 0,
  max: 90,
  step: 1,
  unit: '%',
  priority: 21,
};

/** 按键浮层显示多久后淡出(毫秒,VSCode screencastMode.keyboardOverlayTimeout,默认 800,500..5000)。 */
export const SCREENCAST_KEYBOARD_OVERLAY_TIMEOUT: CoreSettingSpec<number> = {
  id: 'screencastMode.keyboardOverlayTimeout',
  category: 'general',
  group: 'screencast',
  groupKey: 'settings.group.screencast',
  title: 'Keyboard overlay timeout',
  titleKey: 'settings.screencast.keyboard_overlay_timeout',
  descriptionKey: 'settings.screencast.keyboard_overlay_timeout.desc',
  type: 'number',
  default: 800,
  min: 500,
  max: 5000,
  step: 100,
  unit: 'ms',
  priority: 22,
};
