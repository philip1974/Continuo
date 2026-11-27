// 语言功能类编辑器命令的 CodeMirror 实现(引擎 chunk;命令表见 editor-text-commands,经 codemirror-text-commands 的 RUNNERS 登记):
// - 格式化文档(editor.action.formatDocument,⇧⌥F):JSON(含 jsonc)按当前缩进单位(indentUnit)重排空白,一次撤销;语法错误 →
//   提示且不改文档;其它语言 → 提示「没有格式化程序」(VSCode formatDocument.none 的文案)。
// - 重命名 / 转到定义 / 快速修复(F2 / F12 / ⌘.):本项目没有语言服务 → 按 VSCode 无结果时的文案提示,不再静默。
// - 下一个问题(F8):跳到下一个诊断(CodeMirror lint 的 nextDiagnostic,⇧⌘M 的面板同源);没有诊断 → 提示。
// - 触发建议(⌃Space / ⌘I):CodeMirror 补全的 startCompletion(⌃Space 同时仍在补全扩展自带的键表里,同一命令)。
//   这两个 CodeMirror 命令按键从 basicSetup 键表里取(@codemirror/lint / autocomplete 不是本项目的直接依赖,不另引入)。
// - 扩展 / 收缩选区(VSCode smartSelect,mac ⌃⇧⌘→ / ⌃⇧⌘←):扩展到父语法节点;收缩退回上一次扩展前的选区(中间有别的
//   选区变化 / 编辑 → 历史作废,同 VSCode)。
// BDD: src/__tests__/editor-language-commands/

import { basicSetup } from 'codemirror';
import { keymap, type Command, type EditorView } from '@codemirror/view';
import { Annotation, EditorState, StateField, type EditorSelection, type Extension } from '@codemirror/state';
import { indentUnit, language } from '@codemirror/language';
import { selectParentSyntax } from '@codemirror/commands';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { formatJson } from './json-format';

/** 语言名(VSCode languageId 的近似):Markdown 源码模式的 frontmatter 包装语言按 markdown;纯文本 plaintext。 */
export function languageIdOf(view: EditorView): string {
  const name = view.state.facet(language)?.name;
  if (!name) return 'plaintext';
  return name === 'yaml-frontmatter' ? 'markdown' : name;
}

/** 首尾公共部分不动,只替换中间(光标 / 选区在未改动处保持原位)。 */
function minimalChange(prev: string, next: string): { from: number; to: number; insert: string } | null {
  if (prev === next) return null;
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  return { from: p, to: prev.length - s, insert: next.slice(p, next.length - s) };
}

export const formatDocument: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const lang = languageIdOf(view);
  if (lang !== 'json') {
    notify.info(t('editor.format.no_formatter', { name: lang }));
    return false;
  }
  const doc = state.doc.toString();
  const formatted = formatJson(doc, state.facet(indentUnit));
  if (formatted === null) {
    notify.warn(t('editor.format.json_syntax_error'));
    return false;
  }
  const change = minimalChange(doc, formatted);
  if (change) view.dispatch({ changes: change, userEvent: 'input.format', scrollIntoView: true });
  return true;
};

/** 光标处的单词(VSCode「No definition found for 'foo'」里的 foo);不在单词上 → undefined。 */
function wordAtCursor(view: EditorView): string | undefined {
  const range = view.state.wordAt(view.state.selection.main.head);
  return range ? view.state.sliceDoc(range.from, range.to) : undefined;
}

export const renameSymbol: Command = () => {
  notify.info(t('editor.rename.no_result'));
  return false;
};

export const revealDefinition: Command = (view) => {
  const word = wordAtCursor(view);
  notify.info(word === undefined ? t('editor.definition.none') : t('editor.definition.none_for', { name: word }));
  return false;
};

export const quickFix: Command = () => {
  notify.info(t('editor.quick_fix.none'));
  return false;
};

/** basicSetup 键表里某键的命令(CodeMirror 自带;找不到 → 抛错,升级 codemirror 包时由规范发现)。 */
function basicSetupCommand(key: string): Command {
  const run = EditorState.create({ extensions: basicSetup })
    .facet(keymap)
    .flat()
    .find((b) => b.key === key)?.run;
  if (!run) throw new Error(`basicSetup has no ${key} binding`);
  return run;
}

/** CodeMirror lint 的 nextDiagnostic(basicSetup 的 F8)。 */
export const nextDiagnosticCommand: Command = basicSetupCommand('F8');
/** CodeMirror 补全的 startCompletion(basicSetup 的 Ctrl-Space)。 */
export const startCompletionCommand: Command = basicSetupCommand('Ctrl-Space');

export const nextProblem: Command = (view) => {
  if (nextDiagnosticCommand(view)) return true;
  notify.info(t('editor.problems.none'));
  return false;
};

// ---- 扩展 / 收缩选区 ----

const smartSelectStep = Annotation.define<'expand' | 'shrink'>();

/** 扩展前的选区栈(最近一次在末尾);其它选区变化 / 文档修改 → 清空。 */
const smartSelectHistory = StateField.define<readonly EditorSelection[]>({
  create: () => [],
  update(stack, tr) {
    const step = tr.annotation(smartSelectStep);
    if (step === 'expand') return [...stack, tr.startState.selection];
    if (step === 'shrink') return stack.slice(0, -1);
    return tr.docChanged || tr.selection ? [] : stack;
  },
});

export const expandSelection: Command = (view) => {
  let next: EditorSelection | undefined;
  selectParentSyntax({ state: view.state, dispatch: (tr) => (next = tr.newSelection) });
  if (!next || next.eq(view.state.selection)) return false;
  view.dispatch({
    selection: next,
    annotations: smartSelectStep.of('expand'),
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
};

export const shrinkSelection: Command = (view) => {
  const stack = view.state.field(smartSelectHistory, false);
  const prev = stack?.[stack.length - 1];
  if (!prev) return false;
  view.dispatch({ selection: prev, annotations: smartSelectStep.of('shrink'), scrollIntoView: true, userEvent: 'select' });
  return true;
};

/** CodeEditor 的扩展:收缩选区用的扩展历史。 */
export const languageCommandsExtension: Extension = smartSelectHistory;
