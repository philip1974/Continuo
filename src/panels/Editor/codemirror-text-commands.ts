// 文本编辑命令(editor-text-commands 的命令 id)→ CodeMirror 命令。引擎 chunk:CodeEditor 创建视图时调用 codeEditorTextCommands(),
// 登记实现并给 .cm-editor 打上 CodeEditor 标记(editorTextFocus 据此认出代码编辑器,Milkdown 代码块里的 CodeMirror 没有)。
// ROUTED_KEYMAP_COMMANDS 是 basicSetup 键表里改由注册表分发的 CodeMirror 命令(codemirror-basic-setup 去掉它们的键)。
// BDD: src/__tests__/editor-text-commands/

import { EditorView, type Command } from '@codemirror/view';
import { EditorSelection, StateEffect, type EditorState, type Extension } from '@codemirror/state';
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
import {
  codeFolding,
  foldable,
  foldAll,
  foldCode,
  foldEffect,
  foldedRanges,
  foldState,
  unfoldAll,
  unfoldCode,
} from '@codemirror/language';
import {
  findNext,
  findPrevious,
  openSearchPanel,
  selectNextOccurrence,
  selectSelectionMatches,
} from '@codemirror/search';
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

/**
 * 包住 pos 的最内层可折叠区域(VSCode editor.fold 的目标):从 pos 所在行往上逐行找可折叠区域,第一个延伸到该行的即最内层
 *(区域按行嵌套)。区域含首行(折叠起点在首行行尾)与末行(`}` 所在行);已折叠的跳过,取外一层(VSCode 同:折叠未折叠的最内层)。
 */
export function enclosingFoldRange(state: EditorState, pos: number): { from: number; to: number } | null {
  const folded = foldedRanges(state);
  const at = state.doc.lineAt(pos);
  for (let line = at; ; line = state.doc.lineAt(line.from - 1)) {
    const range = foldable(state, line.from, line.to);
    if (range && range.to >= at.from) {
      let isFolded = false;
      folded.between(range.from, range.from, (from, to) => {
        if (from === range.from && to === range.to) isFolded = true;
      });
      if (!isFolded) return range;
    }
    if (line.from === 0) return null;
  }
}

/**
 * 折叠(VSCode editor.fold):每个光标各折叠包住它的最内层区域(CodeMirror 的 foldCode 只认从光标所在行开始的区域,且只折一个)。
 * 光标落在被折叠的内容里 → 移到折叠起点(首行行尾),不藏在占位符后面。
 */
export const foldEnclosing: Command = (view) => {
  const { state } = view;
  const ranges: { from: number; to: number }[] = [];
  for (const { head } of state.selection.ranges) {
    const range = enclosingFoldRange(state, head);
    if (range && !ranges.some((r) => r.from === range.from && r.to === range.to)) ranges.push(range);
  }
  if (ranges.length === 0) return false;
  const inside = (pos: number) => ranges.find((r) => r.from < pos && pos < r.to);
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => {
      const hidden = inside(r.head);
      return hidden ? EditorSelection.cursor(hidden.from) : r;
    }),
    state.selection.mainIndex,
  );
  const first = ranges[0]!;
  const effects: StateEffect<unknown>[] = ranges.map((r) => foldEffect.of(r));
  effects.push(
    EditorView.announce.of(
      `${state.phrase('Folded lines')} ${state.doc.lineAt(first.from).number} ${state.phrase('to')} ${state.doc.lineAt(first.to).number}.`,
    ),
  );
  if (!state.field(foldState, false)) effects.push(StateEffect.appendConfig.of(codeFolding()));
  view.dispatch({ effects, selection });
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
  'editor.fold': foldEnclosing,
  'editor.unfold': unfoldCode,
  'editor.foldAll': foldAll,
  'editor.unfoldAll': unfoldAll,
  'editor.action.jumpToBracket': cursorMatchingBracket,
  cursorUndo: undoSelection,
  // 查找 / 替换 / 查找下一个·上一个(when: editorFocus,查找面板里同样生效;BDD: src/__tests__/editor-find-keybindings/)
  'actions.find': openFindPanel,
  'editor.action.startFindReplaceAction': openReplacePanel,
  'editor.action.nextMatchFindAction': findNext,
  'editor.action.previousMatchFindAction': findPrevious,
};

/**
 * basicSetup 键表里改由注册表分发的命令(其键从键表去掉):selectSelectionMatches / selectLine / foldCode 由 selectHighlights /
 * expandLineSelection / foldEnclosing 取代,openSearchPanel(⌘F)由 openFindPanel 取代。
 */
export const ROUTED_KEYMAP_COMMANDS: ReadonlySet<Command> = new Set([
  ...Object.values(RUNNERS),
  selectSelectionMatches,
  selectLine,
  foldCode,
  openSearchPanel,
]);

function runTextCommand(id: string, view: EditorView): void {
  if (Object.hasOwn(RUNNERS, id)) RUNNERS[id]!(view);
}

const textEditorMarker = EditorView.editorAttributes.of({ [TEXT_EDITOR_ATTR]: '' });

/** CodeEditor 的扩展:登记命令实现 + CodeEditor 标记。 */
export function codeEditorTextCommands(): Extension {
  registerTextCommandRunner(runTextCommand);
  return textEditorMarker;
}
