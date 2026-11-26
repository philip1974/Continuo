// 命令的上下文条件(对齐 VSCode 同名 context key):
// - `editorTextFocus`:按键落在代码编辑器(CodeEditor 的 CodeMirror)正文里;
// - `editorFocus`:按键落在代码编辑器里,含其查找面板等编辑器内控件(VSCode:查找 / 查找下一个等 find 命令用它,查找框里同样生效)。
// CodeEditor 的 .cm-editor 带 TEXT_EDITOR_ATTR 标记;Milkdown 代码块里的 CodeMirror 没有 → 都不算。输入法组字中都不算(按键属于组字)。
// BDD: src/__tests__/editor-text-commands/、src/__tests__/editor-find-keybindings/

/** CodeEditor 根元素(.cm-editor)上的标记属性。 */
export const TEXT_EDITOR_ATTR = 'data-co-text-editor';

/** 命令的上下文条件(CommandSpec.when)。 */
export type CommandWhen = 'editorTextFocus' | 'editorFocus';

export function isCommandWhen(value: unknown): value is CommandWhen {
  return value === 'editorTextFocus' || value === 'editorFocus';
}

/**
 * 条件 a 成立处 b 是否必然成立(a 的上下文被 b 完全覆盖):b 无条件、两者相同,或 a = editorTextFocus 而 b = editorFocus(正文是
 * 编辑器的一部分)。分发表里前面的绑定 b 在后面同键绑定 a 的全部上下文里都胜出时,a 算冲突落败。
 */
export function whenCoveredBy(a: CommandWhen | undefined, b: CommandWhen | undefined): boolean {
  return b === undefined || a === b || (a === 'editorTextFocus' && b === 'editorFocus');
}

/** 元素是否在代码编辑器正文里(CodeEditor 的 .cm-content)。 */
export function isEditorTextElement(el: Element | null): boolean {
  if (typeof el?.closest !== 'function') return false;
  const content = el.closest('.cm-content');
  return content?.closest('.cm-editor')?.hasAttribute(TEXT_EDITOR_ATTR) === true;
}

/** 元素是否在代码编辑器里(正文或查找面板等编辑器内控件)。 */
export function isEditorElement(el: Element | null): boolean {
  if (typeof el?.closest !== 'function') return false;
  return el.closest('.cm-editor')?.hasAttribute(TEXT_EDITOR_ATTR) === true;
}

function holdsFor(when: CommandWhen, el: Element | null): boolean {
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
