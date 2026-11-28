// @vitest-environment jsdom
// BDD: editor-clipboard —— 无选区整行复制 / 剪切带换行 + 编辑器元数据、粘贴整行插到上方、多光标分配、撤销断点。见同目录 README。
import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  EDITOR_CLIPBOARD_MIME,
  editorClipboard,
  editorCopyData,
  editorPasteTransaction,
  parseEditorClipboardMeta,
  type EditorClipboardMeta,
} from '../../panels/Editor/codemirror-clipboard';

function stateOf(doc: string, ranges: [number, number?][], extensions: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h ?? a))),
    extensions: [EditorState.allowMultipleSelections.of(true), ...extensions],
  });
}

const LINEWISE: EditorClipboardMeta = { version: 1, linewise: true, multicursorText: null, mode: null };

describe('复制 / 剪切的内容', () => {
  it('无选区 → 整行带换行,元数据 linewise', () => {
    const c = editorCopyData(stateOf('alpha\nbeta\ngamma', [[8]]));
    expect(c.text).toBe('beta\n');
    expect(c.meta.linewise).toBe(true);
    expect(c.meta.multicursorText).toBeNull();
  });

  it('末行也带换行(外部粘贴是完整一行)', () => {
    expect(editorCopyData(stateOf('alpha\nbeta', [[7]])).text).toBe('beta\n');
  });

  it('多个空光标:各行相接,同一行只取一次,各段进 multicursorText', () => {
    const c = editorCopyData(stateOf('a1\nb2\nc3', [[0], [1], [7]]));
    expect(c.text).toBe('a1\nc3\n');
    expect(c.meta.multicursorText).toEqual(['a1\n', 'c3\n']);
  });

  it('有非空选区 → 只取非空选区,多段换行拼接', () => {
    const c = editorCopyData(stateOf('hello world\nfoo bar', [[0, 5], [12, 15]]));
    expect(c.text).toBe('hello\nfoo');
    expect(c.meta.linewise).toBe(false);
    expect(c.meta.multicursorText).toEqual(['hello', 'foo']);
  });

  it('元数据带语言名(纯文本 → null)', () => {
    expect(editorCopyData(stateOf('let a', [[0]], [javascript()])).meta.mode).toBe('javascript');
    expect(editorCopyData(stateOf('x', [[0]])).meta.mode).toBeNull();
  });

  it('剪切整行范围照 VSCode:中间行删到下一行首;末行连前一个换行;只有一行删内容', () => {
    expect(editorCopyData(stateOf('a\nb\nc', [[2]])).cutRanges).toEqual([{ from: 2, to: 4 }]);
    expect(editorCopyData(stateOf('a\nb\nc', [[4]])).cutRanges).toEqual([{ from: 3, to: 5 }]);
    expect(editorCopyData(stateOf('only', [[1]])).cutRanges).toEqual([{ from: 0, to: 4 }]);
    // 倒数第二行与末行都有光标:倒数第二行删到末行首,末行接着只删内容(不重叠)
    expect(editorCopyData(stateOf('a\nb\nc', [[2], [4]])).cutRanges).toEqual([
      { from: 2, to: 4 },
      { from: 4, to: 5 },
    ]);
  });

  it('元数据解析:非法 / 版本不符 → null', () => {
    expect(parseEditorClipboardMeta('')).toBeNull();
    expect(parseEditorClipboardMeta('{bad')).toBeNull();
    expect(parseEditorClipboardMeta('{"version":2,"linewise":true}')).toBeNull();
    expect(parseEditorClipboardMeta(JSON.stringify(LINEWISE))).toEqual(LINEWISE);
  });
});

function applyPaste(state: EditorState, text: string, meta: EditorClipboardMeta | null): EditorState {
  return state.update(editorPasteTransaction(state, text, meta)).state;
}

describe('粘贴', () => {
  it('整行标记 + 光标无选区 → 插到所在行上方,光标随原位置下移', () => {
    const s = applyPaste(stateOf('one\ntwo', [[5]]), 'copied\n', LINEWISE);
    expect(s.doc.toString()).toBe('one\ncopied\ntwo');
    expect(s.selection.main.head).toBe(12);
  });

  it('无标记(外部内容)→ 插在光标处', () => {
    const s = applyPaste(stateOf('one\ntwo', [[5]]), 'copied\n', null);
    expect(s.doc.toString()).toBe('one\ntcopied\nwo');
  });

  it('整行标记但有选区 → 替换选区', () => {
    const s = applyPaste(stateOf('one\ntwo', [[4, 7]]), 'x\n', LINEWISE);
    expect(s.doc.toString()).toBe('one\nx\n');
  });

  it('多光标:段数 = 光标数 → 逐个分配;整行段插到各自行上方', () => {
    const multi: EditorClipboardMeta = { ...LINEWISE, multicursorText: ['A\n', 'B\n'] };
    const s = applyPaste(stateOf('x\ny', [[0], [2]]), 'A\nB\n', multi);
    expect(s.doc.toString()).toBe('A\nx\nB\ny');
    const words: EditorClipboardMeta = { version: 1, linewise: false, multicursorText: ['1', '2'], mode: null };
    expect(applyPaste(stateOf('a b', [[1], [3]]), '1\n2', words).doc.toString()).toBe('a1 b2');
  });

  it('外部多行文本行数 = 光标数(去掉末尾换行)→ 按行分配', () => {
    expect(applyPaste(stateOf('a\nb', [[1], [3]]), 'X\nY\n', null).doc.toString()).toBe('aX\nbY');
  });

  it('粘贴前后断开撤销:紧接着的输入不与粘贴合成一次撤销', () => {
    let s = stateOf('', [[0]], [history()]);
    s = s.update({ changes: { from: 0, insert: 'a' }, selection: { anchor: 1 }, userEvent: 'input.type' }).state;
    s = applyPaste(s, 'P', null);
    s = s.update({ changes: { from: 2, insert: 'b' }, selection: { anchor: 3 }, userEvent: 'input.type' }).state;
    expect(s.doc.toString()).toBe('aPb');
    const view = { get state() { return s; }, dispatch: (tr: { state: EditorState }) => (s = tr.state) };
    undo(view as never);
    expect(s.doc.toString()).toBe('aP');
    undo(view as never);
    expect(s.doc.toString()).toBe('a');
  });
});

class FakeDataTransfer {
  readonly data = new Map<string, string>();
  get types(): string[] {
    return [...this.data.keys()];
  }
  readonly files = [] as unknown as FileList;
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
  clearData(): void {
    this.data.clear();
  }
}

function clipboardEvent(type: string, data: FakeDataTransfer): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: data });
  return e;
}

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, anchor: number, extra: Extension[] = []): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [history(), editorClipboard({ copyWithSyntaxHighlighting: () => false }), ...extra],
    }),
    parent: document.body,
  });
  return view;
}

describe('DOM 事件', () => {
  it('⌘C 无选区:剪贴板 = 整行 + 换行,另带元数据;阻止默认', () => {
    const v = mount('one\ntwo', 5);
    const data = new FakeDataTransfer();
    const e = clipboardEvent('copy', data);
    v.contentDOM.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(data.getData('text/plain')).toBe('two\n');
    expect(parseEditorClipboardMeta(data.getData(EDITOR_CLIPBOARD_MIME))?.linewise).toBe(true);
  });

  it('⌘X 无选区删整行,剪切单独一次撤销;只读时不删', () => {
    const v = mount('one\ntwo\nthree', 5);
    v.contentDOM.dispatchEvent(clipboardEvent('cut', new FakeDataTransfer()));
    expect(v.state.doc.toString()).toBe('one\nthree');
    undo(v);
    expect(v.state.doc.toString()).toBe('one\ntwo\nthree');
    view!.destroy();
    const ro = mount('one\ntwo', 5, [EditorState.readOnly.of(true)]);
    const data = new FakeDataTransfer();
    ro.contentDOM.dispatchEvent(clipboardEvent('cut', data));
    expect(ro.state.doc.toString()).toBe('one\ntwo');
    expect(data.getData('text/plain')).toBe('two\n');
  });

  it('另一个窗口的复制(只有剪贴板里的元数据,没有本进程状态)粘贴 → 整行插到上方', () => {
    const v = mount('first\nsecond', 8);
    const data = new FakeDataTransfer();
    data.setData('text/plain', 'copied\n');
    data.setData(EDITOR_CLIPBOARD_MIME, JSON.stringify(LINEWISE));
    v.contentDOM.dispatchEvent(clipboardEvent('paste', data));
    expect(v.state.doc.toString()).toBe('first\ncopied\nsecond');
  });

  it('没有文本(只有文件)的粘贴不处理', () => {
    const v = mount('x', 0);
    const e = clipboardEvent('paste', new FakeDataTransfer());
    v.contentDOM.dispatchEvent(e);
    expect(v.state.doc.toString()).toBe('x');
  });
});
