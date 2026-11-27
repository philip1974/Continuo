// 自动换行的续行缩进(对齐 VSCode editor.wrappingIndent 默认 same):开了自动换行时,一行折出来的续行与该行首行的缩进对齐,
// 而不是从第 0 列开始(否则缩进参考线竖穿续行文字)。
//
// - 缩进列数照 VSCode computeWrappedTextIndentLength(monospaceLineBreaksComputer):只数行首空白,空格算 1 列、tab 跳到下一个
//   tabSize 倍数列;整行都是空白 → 0。缩进 + 一个全角字符(2 列)放不下 → 0(VSCode「Force sticking to beginning of line if
//   no character would fit except for the indentation」)。
// - 渲染:行装饰 padding-left 加 N 列、text-indent 减 N 列(悬挂缩进):首行位置不变,续行右移 N 列。光标 / 点击定位 / 选区
//   都按 DOM 实测(CodeMirror drawSelection 取行左边界时本就计入负 text-indent),行号按行高对齐不受影响。参考线的伪元素
//   按行的内边距盒定位,不随 padding 移动。
// - 只为可见行生成装饰(长文件不随行数变慢);只读行首空白(2 MB 单行不整行切片)。可用宽度只在几何变化时(CodeMirror
//   测量之后,布局是干净的)读取,不在每次按键时强制布局。
// BDD: src/__tests__/editor-wrapping-indent/

import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/** 全角字符占的列数(VSCode columnsForFullWidthChar 默认 2)。 */
const FULL_WIDTH_COLUMNS = 2;
/** 行首空白最多读这么多字符:再长也必然放不下(退回不缩进),不为 2 MB 单行整行切片。 */
const MAX_SCAN = 1024;

/**
 * 续行缩进列数(VSCode wrappingIndent: same)。wrapColumns = 一个视觉行能放下的列数(未知传 Infinity:不做放不下的退回)。
 */
export function wrappedIndentColumns(leading: string, tabSize: number, wrapColumns: number): number {
  let cols = 0;
  let i = 0;
  for (; i < leading.length; i++) {
    const c = leading.charCodeAt(i);
    if (c === 9) cols += tabSize - (cols % tabSize);
    else if (c === 32) cols += 1;
    else break;
  }
  if (i === leading.length) return 0; // 整行空白(或扫描范围内全是空白)
  return cols + FULL_WIDTH_COLUMNS > wrapColumns ? 0 : cols;
}

/** 行内容可用宽度(px):内容区宽 − 内容区左右内边距 − 行默认左右内边距(CodeMirror .cm-line 6px / 2px)。 */
function lineContentWidth(view: EditorView): number {
  const content = view.contentDOM;
  const style = getComputedStyle(content);
  return content.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0') - 8;
}

const decoCache = new Map<number, Decoration>();
function hangingIndent(cols: number): Decoration {
  let deco = decoCache.get(cols);
  if (!deco) {
    deco = Decoration.line({
      class: 'cm-wrap-indent',
      attributes: { style: `padding-left: calc(6px + ${cols}ch); text-indent: -${cols}ch` },
    });
    decoCache.set(cols, deco);
  }
  return deco;
}

function build(view: EditorView, state: EditorState, width: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const charWidth = view.defaultCharacterWidth;
  const wrapColumns = width > 0 && charWidth > 0 ? width / charWidth : Infinity;
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.from === last) continue;
      last = line.from;
      const cols = wrappedIndentColumns(
        state.sliceDoc(line.from, Math.min(line.to, line.from + MAX_SCAN)),
        state.tabSize,
        wrapColumns,
      );
      if (cols > 0) builder.add(line.from, line.from, hangingIndent(cols));
    }
  }
  return builder.finish();
}

const wrappingIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** 行内容可用宽度(px);0 = 尚未测量(此时不做放不下的退回)。 */
    width = 0;
    constructor(view: EditorView) {
      this.decorations = build(view, view.state, 0);
    }
    update(update: ViewUpdate) {
      let widthChanged = false;
      if (update.geometryChanged) {
        const width = lineContentWidth(update.view);
        if (Math.abs(width - this.width) >= 1) {
          this.width = width;
          widthChanged = true;
        }
      }
      if (widthChanged || update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize) {
        this.decorations = build(update.view, update.state, this.width);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** 续行缩进(只在自动换行开时装上)。 */
export const wrappingIndent: Extension = [
  wrappingIndentPlugin,
  // 行内的 inline-block 元素(小部件)会继承 text-indent:归零,只让行本身悬挂缩进
  EditorView.theme({ '.cm-wrap-indent *': { textIndent: '0' } }),
];

/** editor.wordWrap 对应的扩展:换行 + 续行缩进(VSCode wrappingIndent 默认 same)。 */
export function editorWordWrap(on: boolean): Extension {
  return on ? [EditorView.lineWrapping, wrappingIndent] : [];
}
