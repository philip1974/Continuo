// 文本编辑命令(editor-text-commands 的命令 id)→ CodeMirror 命令。引擎 chunk:CodeEditor 创建视图时调用 codeEditorTextCommands(),
// 登记实现并给 .cm-editor 打上 CodeEditor 标记(editorTextFocus 据此认出代码编辑器,Milkdown 代码块里的 CodeMirror 没有)。
// ROUTED_KEYMAP_COMMANDS 是 basicSetup 键表里改由注册表分发的 CodeMirror 命令(codemirror-basic-setup 去掉它们的键)。
// BDD: src/__tests__/editor-text-commands/

import { EditorView, type Command } from '@codemirror/view';
import { EditorSelection, type Extension } from '@codemirror/state';
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  selectLine,
  toggleBlockComment,
  toggleComment,
  undoSelection,
} from '@codemirror/commands';
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language';
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import { openFindPanel, openReplacePanel } from './codemirror-find';
import { TEXT_EDITOR_ATTR } from '@/lib/editor-text-focus';
import { registerTextCommandRunner } from './editor-text-commands';

/** 在每个光标所在行的上方插入一行(沿用该行缩进),光标落到新行(VSCode insertLineBefore;CodeMirror 无对应命令)。 */
export const insertLineBefore: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  view.dispatch(
    state.update(
      state.changeByRange((range) => {
        const line = state.doc.lineAt(range.head);
        const indent = /^[ \t]*/.exec(line.text)![0];
        return {
          changes: { from: line.from, insert: indent + state.lineBreak },
          range: EditorSelection.cursor(line.from + indent.length),
        };
      }),
      { scrollIntoView: true, userEvent: 'input' },
    ),
  );
  return true;
};

/**
 * 选中行(VSCode expandLineSelection):每个选区扩到「起始行行首 → 结束行的下一行行首」(末行到文档末尾)。已是整行选区时
 * 结束位置在下一行行首 → 再按一次多选一行(CodeMirror 的 selectLine 不会向下扩展)。
 */
export const expandLineSelection: Command = ({ state, dispatch }) => {
  const { doc } = state;
  const ranges = state.selection.ranges.map((r) =>
    EditorSelection.range(doc.lineAt(r.from).from, Math.min(doc.lineAt(r.to).to + 1, doc.length)),
  );
  dispatch(state.update({ selection: EditorSelection.create(ranges, state.selection.mainIndex), userEvent: 'select' }));
  return true;
};

/** 选择所有匹配:空选区先取光标处单词(VSCode 同;CodeMirror 的 selectSelectionMatches 要求已有选区)。 */
const selectHighlights: Command = (view) => {
  const { selection } = view.state;
  if (selection.ranges.length === 1 && selection.main.empty) selectNextOccurrence(view);
  return selectSelectionMatches(view);
};

const RUNNERS: Readonly<Record<string, Command>> = {
  'editor.action.commentLine': toggleComment,
  'editor.action.blockComment': toggleBlockComment,
  'editor.action.moveLinesUpAction': moveLineUp,
  'editor.action.moveLinesDownAction': moveLineDown,
  'editor.action.copyLinesUpAction': copyLineUp,
  'editor.action.copyLinesDownAction': copyLineDown,
  'editor.action.deleteLines': deleteLine,
  'editor.action.insertLineAfter': insertBlankLine,
  'editor.action.insertLineBefore': insertLineBefore,
  'editor.action.indentLines': indentMore,
  'editor.action.outdentLines': indentLess,
  'editor.action.addSelectionToNextFindMatch': selectNextOccurrence,
  'editor.action.selectHighlights': selectHighlights,
  'editor.action.insertCursorAbove': addCursorAbove,
  'editor.action.insertCursorBelow': addCursorBelow,
  expandLineSelection,
  'editor.fold': foldCode,
  'editor.unfold': unfoldCode,
  'editor.foldAll': foldAll,
  'editor.unfoldAll': unfoldAll,
  'editor.action.jumpToBracket': cursorMatchingBracket,
  cursorUndo: undoSelection,
};

/** basicSetup 键表里改由注册表分发的命令(其键从键表去掉;selectSelectionMatches / selectLine 由 selectHighlights / expandLineSelection 取代)。 */
export const ROUTED_KEYMAP_COMMANDS: ReadonlySet<Command> = new Set([
  ...Object.values(RUNNERS),
  selectSelectionMatches,
  selectLine,
]);

// 查找 / 替换:默认键留在 CodeMirror 查找键表(查找面板内的 ⌘F 也靠它),不进 ROUTED_KEYMAP_COMMANDS。
const FIND_RUNNERS: Readonly<Record<string, Command>> = {
  'actions.find': openFindPanel,
  'editor.action.startFindReplaceAction': openReplacePanel,
};

function runTextCommand(id: string, view: EditorView): void {
  if (Object.hasOwn(RUNNERS, id)) RUNNERS[id]!(view);
  else if (Object.hasOwn(FIND_RUNNERS, id)) FIND_RUNNERS[id]!(view);
}

const textEditorMarker = EditorView.editorAttributes.of({ [TEXT_EDITOR_ATTR]: '' });

/** CodeEditor 的扩展:登记命令实现 + CodeEditor 标记。 */
export function codeEditorTextCommands(): Extension {
  registerTextCommandRunner(runTextCommand);
  return textEditorMarker;
}
