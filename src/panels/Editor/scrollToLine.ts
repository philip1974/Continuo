import { EditorView } from '@codemirror/view';

/** 光标移到第 line 行(1 起)并居中;column(1 起,可选)超出行长时落在行尾,非法则行首。 */
export function scrollToLine(
  view: EditorView,
  line: number,
  column?: number,
): 'applied' | 'out-of-range' {
  if (!Number.isInteger(line) || line < 1) return 'out-of-range';
  const doc = view.state.doc;
  if (line > doc.lines) return 'out-of-range';
  const target = doc.line(line);
  const offset = column !== undefined && Number.isInteger(column) && column > 1 ? column - 1 : 0;
  const pos = offset > 0 ? target.from + Math.min(offset, target.length) : target.from;
  view.dispatch({
    selection: { anchor: pos, head: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.focus();
  return 'applied';
}
