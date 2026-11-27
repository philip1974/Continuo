// 行号栏鼠标选行(对齐 VSCode:viewController.dispatchMouse 的 startedOnLineNumbers 分支 → CursorMoveCommands.line):
// - 单击行号 → 选中整行(含换行:光标落到下一行行首;最后一行到文末);
// - 按住拖动 → 按行扩展(向下:起始行行首 → 当前行的下一行行首;向上:起始行的下一行行首 → 当前行行首),拖出编辑器上 / 下缘时自动滚动;
// - ⇧ 单击 → 从当前选区起点按行扩展到所点行(紧接在行号选行之后则以那整行为起点,VSCode selectionStart 同);
// - ⌥ 单击(多光标修饰键,VSCode multiCursorModifier 默认 alt)→ 另加一个选中该行的光标;⇧⌥ 单击 → 把最后一个光标换成选中该行;
// - mac 上 ⌃ 单击是右键菜单,不处理;折叠栏 / 断点栏不受影响(只挂在行号栏上)。
// 拖动时行号文字不会被浏览器选中:按下即接管(preventDefault),gutter 另设 user-select: none(code-editor 主题)。
// BDD: src/__tests__/editor-line-number-select/

import { EditorSelection, type SelectionRange, type Text } from '@codemirror/state';
import { lineNumbers, type BlockInfo, type EditorView } from '@codemirror/view';

/** 文档区间(VSCode SingleCursorState.selectionStart:行号选行时是整行)。 */
export interface DocRange {
  readonly from: number;
  readonly to: number;
}

/** 第 fromLine..toLine 行(1 起,含两端)的整行区间:首行行首 → 末行的下一行行首(末行是最后一行 → 文末)。 */
export function wholeLinesRange(doc: Text, fromLine: number, toLine: number): DocRange {
  const a = Math.max(1, Math.min(fromLine, toLine, doc.lines));
  const b = Math.min(doc.lines, Math.max(fromLine, toLine));
  return { from: doc.line(a).from, to: b < doc.lines ? doc.line(b + 1).from : doc.length };
}

/** 行块(折叠时一块含多行)覆盖的整行区间。 */
function blockLines(doc: Text, block: Pick<BlockInfo, 'from' | 'to'>): DocRange {
  return wholeLinesRange(doc, doc.lineAt(block.from).number, doc.lineAt(block.to).number);
}

/**
 * 以 start 为起点按行扩展到 target 行块的选区(CursorMoveCommands.line 的「继续选行」):target 在起点所在行之上 → 锚点 = 起点区间末、
 * 头 = target 行首;之下 → 锚点 = 起点区间首、头 = target 末行的下一行行首;同一行 → 起点区间本身。
 */
export function extendLineSelection(
  doc: Text,
  start: DocRange,
  target: Pick<BlockInfo, 'from' | 'to'>,
): { readonly anchor: number; readonly head: number } {
  const startLine = doc.lineAt(start.from).number;
  const lines = blockLines(doc, target);
  if (doc.lineAt(target.to).number < startLine) return { anchor: start.to, head: lines.from };
  if (doc.lineAt(target.from).number > startLine) return { anchor: start.from, head: lines.to };
  return { anchor: start.from, head: start.to };
}

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

// 上次行号选行的起点区间与它产生的选区:⇧ 单击时主选区仍是它 → 以整行为起点(否则以主选区锚点为起点)。
const lastLineSelect = new WeakMap<EditorView, { readonly start: DocRange; readonly anchor: number; readonly head: number }>();

function selectRange(view: EditorView, anchor: number, head: number, start: DocRange): void {
  lastLineSelect.set(view, { start, anchor, head });
  view.dispatch({ selection: { anchor, head }, userEvent: 'select.pointer', scrollIntoView: true });
}

function shiftStart(view: EditorView): DocRange {
  const main = view.state.selection.main;
  const last = lastLineSelect.get(view);
  if (last && last.anchor === main.anchor && last.head === main.head) return last.start;
  return { from: main.anchor, to: main.anchor };
}

/** 拖动:在 view 所在文档(popout 子窗同样)跟踪鼠标,按行扩展;拖出滚动区上 / 下缘时每帧滚动(距离越远越快)。 */
function trackDrag(view: EditorView, start: DocRange): void {
  const doc = view.dom.ownerDocument;
  const win = doc.defaultView ?? window;
  let lastY: number | null = null;
  let frame = 0;
  const update = () => {
    if (lastY === null) return;
    const rect = view.scrollDOM.getBoundingClientRect();
    const y = Math.min(Math.max(lastY, rect.top + 1), rect.bottom - 1);
    const block = view.lineBlockAtHeight(y - view.documentTop);
    const sel = extendLineSelection(view.state.doc, start, block);
    const main = view.state.selection.main;
    if (main.anchor !== sel.anchor || main.head !== sel.head || view.state.selection.ranges.length > 1) {
      selectRange(view, sel.anchor, sel.head, start);
    }
  };
  const autoScroll = () => {
    frame = 0;
    if (lastY === null) return;
    const rect = view.scrollDOM.getBoundingClientRect();
    const over = lastY < rect.top ? lastY - rect.top : lastY > rect.bottom ? lastY - rect.bottom : 0;
    if (over === 0) return;
    view.scrollDOM.scrollTop += Math.max(-40, Math.min(40, over));
    update();
    frame = win.requestAnimationFrame(autoScroll);
  };
  const onMove = (e: MouseEvent) => {
    if ((e.buttons & 1) === 0) {
      stop();
      return;
    }
    lastY = e.clientY;
    update();
    if (frame === 0) frame = win.requestAnimationFrame(autoScroll);
  };
  const stop = () => {
    lastY = null;
    if (frame !== 0) win.cancelAnimationFrame(frame);
    frame = 0;
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('mouseup', stop, true);
    win.removeEventListener('blur', stop);
  };
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('mouseup', stop, true);
  win.addEventListener('blur', stop);
}

/** 行号栏 mousedown;已处理 → true(CodeMirror 随之 preventDefault:不开始浏览器原生选字)。 */
export function handleLineNumberMouseDown(view: EditorView, block: BlockInfo, event: MouseEvent): boolean {
  if (event.button !== 0) return false;
  if (isMac() && event.ctrlKey) return false;
  const doc = view.state.doc;
  const clicked = blockLines(doc, block);
  view.focus();
  if (event.altKey) {
    const range: SelectionRange = EditorSelection.range(clicked.from, clicked.to);
    const { ranges, mainIndex } = view.state.selection;
    // ⌥:另加一个选中该行的光标;⇧⌥:把最后一个(主)光标换成它
    const next = event.shiftKey
      ? EditorSelection.create(ranges.map((r, i) => (i === mainIndex ? range : r)), mainIndex)
      : EditorSelection.create([...ranges, range], ranges.length);
    view.dispatch({ selection: next, userEvent: 'select.pointer' });
    return true;
  }
  const start = event.shiftKey ? shiftStart(view) : clicked;
  const sel = event.shiftKey ? extendLineSelection(doc, start, block) : { anchor: clicked.from, head: clicked.to };
  selectRange(view, sel.anchor, sel.head, start);
  trackDrag(view, start);
  return true;
}

/** 给 basicSetup 自带的行号栏加上选行(lineNumbers 的 domEventHandlers 按 facet 合并,不会多出一列行号)。 */
export const lineNumberSelect = lineNumbers({
  domEventHandlers: { mousedown: (view, line, event) => handleLineNumberMouseDown(view, line, event as MouseEvent) },
});
