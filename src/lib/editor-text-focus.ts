// 命令的上下文条件 `editorTextFocus`(对齐 VSCode 同名 context key):按键落在代码编辑器(CodeEditor 的 CodeMirror)正文里。
// - CodeEditor 的 .cm-editor 带 TEXT_EDITOR_ATTR 标记;Milkdown 代码块里的 CodeMirror 没有 → 不算;
// - 只认正文(.cm-content),查找面板等 .cm-panel 里的输入框不算;
// - 输入法组字中不算(按键属于组字)。
// BDD: src/__tests__/editor-text-commands/

/** CodeEditor 根元素(.cm-editor)上的标记属性。 */
export const TEXT_EDITOR_ATTR = 'data-co-text-editor';

/** 命令的上下文条件(CommandSpec.when)。 */
export type CommandWhen = 'editorTextFocus';

export function isCommandWhen(value: unknown): value is CommandWhen {
  return value === 'editorTextFocus';
}

/** 元素是否在代码编辑器正文里(CodeEditor 的 .cm-content)。 */
export function isEditorTextElement(el: Element | null): boolean {
  if (typeof el?.closest !== 'function') return false;
  const content = el.closest('.cm-content');
  return content?.closest('.cm-editor')?.hasAttribute(TEXT_EDITOR_ATTR) === true;
}

/** 按键事件是否发生在代码编辑器正文里(且不在输入法组字中)。 */
export function isEditorTextFocusEvent(e: KeyboardEvent): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  return isEditorTextElement(e.target as Element | null);
}

/** 上下文条件对文档当前焦点是否成立(无条件 → 成立;菜单 accelerator 触发的命令据此重新判定,见 menu-commands)。 */
export function whenHoldsInDocument(when: CommandWhen | undefined, doc: Document): boolean {
  return when === undefined || isEditorTextElement(doc.activeElement);
}

/** 命令的上下文条件对该按键是否成立(无条件 → 成立)。 */
export function whenHolds(when: CommandWhen | undefined, e: KeyboardEvent): boolean {
  return when === undefined || isEditorTextFocusEvent(e);
}
