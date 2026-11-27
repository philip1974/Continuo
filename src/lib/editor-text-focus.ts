// 命令的上下文条件(对齐 VSCode 同名 context key):
// - `editorTextFocus`:按键落在代码编辑器(CodeEditor 的 CodeMirror)正文里;
// - `editorFocus`:按键落在编辑器里,含其查找面板等编辑器内控件(VSCode:查找 / 查找下一个等 find 命令用它,查找框里同样生效)。
//   Markdown 编辑 / 预览(Milkdown,外层带 MARKDOWN_EDITOR_ATTR)及其查找条也算:查找类命令在其中转给它的查找条(可改键)。
// CodeEditor 的 .cm-editor 带 TEXT_EDITOR_ATTR 标记;Milkdown 代码块里的 CodeMirror 没有 → 都不算(代码块保留 CodeMirror 自带的
// 查找键)。输入法组字中都不算(按键属于组字)。
// - `terminalNormalBufferFocus`:按键落在终端里且终端在主缓冲(VSCode `terminalFocusInAny && !terminalAltBufferActive`,滚动命令用它):
//   全屏程序(vim / less)切到备用屏时不成立,按键照常交给程序。终端容器带 TERMINAL_ATTR,备用屏时另带 TERMINAL_ALT_BUFFER_ATTR。
// - `terminalFocus`:按键落在终端里(TERMINAL_ATTR 容器内,主缓冲 / 备用屏都算;终端搜索条等不算,同 VSCode terminalFocus)。
// - `terminalSplitFocus`:terminalFocus 且按键所在窗口有不止一个终端窗格(VSCode `terminalFocus && terminalSplitActive`,窗格切换
//   命令用它):没有分屏时不成立,同键让给后面的绑定(mac ⌥⌘→ / ⌥⌘← = 下一个 / 上一个编辑器)。是否分屏由 dock 层注入
//  (provideTerminalSplitActive),本模块不依赖 dock。
// - `markdownEditorFocus`:editorFocus 且是 Markdown 文档(VSCode `editorFocus && resourceLangId == markdown`,切换预览 ⇧⌘V 用它):
//   Markdown 编辑 / 预览(Milkdown 外层),或源码模式的 CodeEditor(语言为 Markdown 时 .cm-editor 另带 MARKDOWN_SOURCE_ATTR)。
//   其它文件的编辑器里不成立(Windows / Linux 的 Ctrl+Shift+V 照常粘贴)。BDD: src/__tests__/workbench-vscode-default-keys/
// BDD: src/__tests__/editor-text-commands/、src/__tests__/editor-find-keybindings/、src/__tests__/terminal-scroll-commands/、
// src/__tests__/terminal-focus-cycle/

/** CodeEditor 根元素(.cm-editor)上的标记属性。 */
export const TEXT_EDITOR_ATTR = 'data-co-text-editor';

/** Markdown 编辑 / 预览(MilkdownEditor)外层(含查找条)上的标记属性。 */
export const MARKDOWN_EDITOR_ATTR = 'data-co-markdown-editor';

/** 语言为 Markdown 的 CodeEditor(源码模式)根元素(.cm-editor)上另带的标记属性。 */
export const MARKDOWN_SOURCE_ATTR = 'data-co-markdown-source';

/** 终端容器(useTerminal 挂 xterm 的元素)上的标记属性;备用屏(alternate screen)激活时另带 TERMINAL_ALT_BUFFER_ATTR。 */
export const TERMINAL_ATTR = 'data-co-terminal';
export const TERMINAL_ALT_BUFFER_ATTR = 'data-co-terminal-alt-buffer';

/** 命令的上下文条件(CommandSpec.when)。 */
export type CommandWhen =
  | 'editorTextFocus'
  | 'editorFocus'
  | 'markdownEditorFocus'
  | 'terminalFocus'
  | 'terminalNormalBufferFocus'
  | 'terminalSplitFocus';

const TERMINAL_WHENS: ReadonlySet<unknown> = new Set<CommandWhen>(['terminalFocus', 'terminalNormalBufferFocus', 'terminalSplitFocus']);

export function isCommandWhen(value: unknown): value is CommandWhen {
  return value === 'editorTextFocus' || value === 'editorFocus' || value === 'markdownEditorFocus' || TERMINAL_WHENS.has(value);
}

/** 两个条件能否同时成立(编辑器类条件之间、终端类条件之间重叠;终端与编辑器互斥)。 */
export function whenOverlaps(a: CommandWhen, b: CommandWhen): boolean {
  return TERMINAL_WHENS.has(a) === TERMINAL_WHENS.has(b);
}

let terminalSplitActive: (doc: Document) => boolean = () => false;

/** 注入「doc 所在窗口是否有不止一个终端窗格」的判定(terminalSplitFocus 用;dock 层提供,见 terminal-focus-cycle)。 */
export function provideTerminalSplitActive(probe: (doc: Document) => boolean): void {
  terminalSplitActive = probe;
}

/**
 * 条件 a 成立处 b 是否必然成立(a 的上下文被 b 完全覆盖):b 无条件、两者相同,或 a = editorTextFocus / markdownEditorFocus 而
 * b = editorFocus(正文 / Markdown 编辑器是编辑器的一部分),或 a = terminalNormalBufferFocus / terminalSplitFocus 而 b = terminalFocus(主缓冲 / 有分屏是终端的一种状态)。
 * 分发表里前面的绑定 b 在后面同键绑定 a 的全部上下文里都胜出时,a 算冲突落败。
 */
export function whenCoveredBy(a: CommandWhen | undefined, b: CommandWhen | undefined): boolean {
  return (
    b === undefined ||
    a === b ||
    ((a === 'editorTextFocus' || a === 'markdownEditorFocus') && b === 'editorFocus') ||
    ((a === 'terminalNormalBufferFocus' || a === 'terminalSplitFocus') && b === 'terminalFocus')
  );
}

/** 元素是否在代码编辑器正文里(CodeEditor 的 .cm-content)。 */
export function isEditorTextElement(el: Element | null): boolean {
  if (typeof el?.closest !== 'function') return false;
  const content = el.closest('.cm-content');
  return content?.closest('.cm-editor')?.hasAttribute(TEXT_EDITOR_ATTR) === true;
}

/**
 * 元素是否在编辑器里:代码编辑器(正文或查找面板等编辑器内控件),或 Markdown 编辑 / 预览(正文或其查找条);
 * Markdown 代码块里的 CodeMirror 不算。
 */
export function isEditorElement(el: Element | null): boolean {
  if (typeof el?.closest !== 'function') return false;
  const cm = el.closest('.cm-editor');
  if (cm) return cm.hasAttribute(TEXT_EDITOR_ATTR);
  return el.closest(`[${MARKDOWN_EDITOR_ATTR}]`) !== null;
}

/** 元素是否在 Markdown 文档的编辑器里:Markdown 编辑 / 预览(含其查找条),或语言为 Markdown 的 CodeEditor(正文或查找面板)。 */
export function isMarkdownEditorElement(el: Element | null): boolean {
  if (!isEditorElement(el)) return false;
  return el!.closest('.cm-editor')?.hasAttribute(MARKDOWN_SOURCE_ATTR) ?? true;
}

/** 元素是否在终端里(TERMINAL_ATTR 容器内;同面板里的搜索条等不算)。 */
export function isTerminalElement(el: Element | null): boolean {
  return typeof el?.closest === 'function' && el.closest(`[${TERMINAL_ATTR}]`) !== null;
}

/** 元素是否在主缓冲(非备用屏)的终端里。 */
export function isTerminalNormalBufferElement(el: Element | null): boolean {
  if (typeof el?.closest !== 'function') return false;
  const host = el.closest(`[${TERMINAL_ATTR}]`);
  return host !== null && !host.hasAttribute(TERMINAL_ALT_BUFFER_ATTR);
}

function holdsFor(when: CommandWhen, el: Element | null): boolean {
  if (when === 'terminalFocus') return isTerminalElement(el);
  if (when === 'terminalSplitFocus') return isTerminalElement(el) && terminalSplitActive(el!.ownerDocument);
  if (when === 'terminalNormalBufferFocus') return isTerminalNormalBufferElement(el);
  if (when === 'markdownEditorFocus') return isMarkdownEditorElement(el);
  return when === 'editorFocus' ? isEditorElement(el) : isEditorTextElement(el);
}

/** 上下文条件对文档当前焦点是否成立(无条件 → 成立;菜单 accelerator 触发的命令据此重新判定,见 menu-commands)。 */
export function whenHoldsInDocument(when: CommandWhen | undefined, doc: Document): boolean {
  return when === undefined || holdsFor(when, doc.activeElement);
}

/** 命令的上下文条件对该按键是否成立(无条件 → 成立)。 */
export function whenHolds(when: CommandWhen | undefined, e: KeyboardEvent): boolean {
  if (when === undefined) return true;
  if (e.isComposing || e.keyCode === 229) return false;
  return holdsFor(when, e.target as Element | null);
}
