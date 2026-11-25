// Markdown 源码视图(CodeMirror)一侧的切模式锚点:卸载时记下顶部可见行与光标行,挂载时取用另一模式留下的锚点。
// BDD: src/__tests__/markdown-mode-position/
import { EditorSelection, type EditorState, type StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { MarkdownModeAnchor } from './editor-view-state-cache';

/** 当前顶部可见的源码行与光标所在行(1 起)。 */
export function sourceModeAnchor(view: EditorView): MarkdownModeAnchor {
  const { doc, selection } = view.state;
  // documentTop:第一行顶边在视口里的 y;滚动容器顶边与它之差 = 已滚过的文档高度。
  const scrolled = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  const top = view.lineBlockAtHeight(Math.max(0, scrolled));
  return {
    mode: 'source',
    topLine: doc.lineAt(top.from).number,
    cursorLine: doc.lineAt(selection.main.head).number,
  };
}

/**
 * 另一模式留下的锚点 → 新视图的初始状态与滚动:顶部可见行滚到视口顶;有光标行(来自编辑模式)则光标移到该行行首
 *(只改选区,文档与撤销历史不变)。
 */
export function applySourceModeAnchor(
  state: EditorState,
  anchor: MarkdownModeAnchor,
): { state: EditorState; scrollTo: StateEffect<unknown> } {
  const lineFrom = (n: number) => state.doc.line(Math.min(Math.max(1, n), state.doc.lines)).from;
  const next =
    anchor.cursorLine === undefined
      ? state
      : state.update({ selection: EditorSelection.cursor(lineFrom(anchor.cursorLine)) }).state;
  return { state: next, scrollTo: EditorView.scrollIntoView(lineFrom(anchor.topLine), { y: 'start' }) };
}
