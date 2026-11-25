import { EditorView } from '@codemirror/view';

/**
 * 光标移到第 line 行(1 起)并居中;column(1 起,可选)超出行长时落在行尾,非法则行首。
 * length(可选,UTF-16 code unit,与搜索结果的列 / 长度同一单位)> 0 时选中 [起点, 起点 + length)(截到行尾),
 * 光标在匹配末尾(VSCode 打开搜索结果选中匹配范围)。
 */
export function scrollToLine(
  view: EditorView,
  line: number,
  column?: number,
  length?: number,
): 'applied' | 'out-of-range' {
  if (!Number.isInteger(line) || line < 1) return 'out-of-range';
  const doc = view.state.doc;
  if (line > doc.lines) return 'out-of-range';
  const target = doc.line(line);
  const offset = column !== undefined && Number.isInteger(column) && column > 1 ? column - 1 : 0;
  const pos = offset > 0 ? target.from + Math.min(offset, target.length) : target.from;
  const head = length !== undefined && Number.isInteger(length) && length > 0 ? Math.min(pos + length, target.from + target.length) : pos;
  view.dispatch({
    selection: { anchor: pos, head },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.focus();
  return 'applied';
}
