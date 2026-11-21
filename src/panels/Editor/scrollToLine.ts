import { EditorView } from '@codemirror/view';

export function scrollToLine(
  view: EditorView,
  line: number,
): 'applied' | 'out-of-range' {
  if (!Number.isInteger(line) || line < 1) return 'out-of-range';
  const doc = view.state.doc;
  if (line > doc.lines) return 'out-of-range';
  const pos = doc.line(line).from;
  view.dispatch({
    selection: { anchor: pos, head: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.focus();
  return 'applied';
}
