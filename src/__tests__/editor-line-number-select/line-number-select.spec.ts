// @vitest-environment jsdom
// BDD: editor-line-number-select —— 单击 / 拖动 / ⇧ 单击 / ⌥ 单击行号选整行;gutter 不可选中文字。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, Text } from '@codemirror/state';
import { codeEditorBasicSetup } from '@/panels/Editor/codemirror-basic-setup';
import { codeEditorTheme } from '@/panels/Editor/code-editor-theme';
import { extendLineSelection, wholeLinesRange } from '@/panels/Editor/codemirror-line-number-select';

const DOC = 'one\ntwo\nthree\nfour\nfive';
const views: EditorView[] = [];

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
});
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(doc = DOC): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [codeEditorBasicSetup, codeEditorTheme('dark')] }),
    parent,
  });
  views.push(view);
  return view;
}

/** 把「鼠标所在高度 → 行块」固定为第 n 行(jsdom 无布局),返回改行的函数。 */
function pointAtLine(view: EditorView, n: number): (m: number) => void {
  let line = n;
  vi.spyOn(view, 'lineBlockAtHeight').mockImplementation(() => view.lineBlockAt(view.state.doc.line(line).from));
  return (m) => {
    line = m;
  };
}

function gutter(view: EditorView): HTMLElement {
  const el = view.dom.querySelector<HTMLElement>('.cm-gutter.cm-lineNumbers');
  if (!el) throw new Error('no line number gutter');
  return el;
}

function press(view: EditorView, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent('mousedown', { button: 0, buttons: 1, bubbles: true, cancelable: true, clientY: 5, ...init });
  gutter(view).dispatchEvent(e);
  return e;
}

const move = (view: EditorView) =>
  view.dom.ownerDocument.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, bubbles: true, clientY: 5 }));
const release = (view: EditorView) =>
  view.dom.ownerDocument.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientY: 5 }));

const sel = (view: EditorView) => {
  const m = view.state.selection.main;
  return { anchor: m.anchor, head: m.head, text: view.state.sliceDoc(m.from, m.to), count: view.state.selection.ranges.length };
};

describe('整行区间与按行扩展(纯函数,VSCode CursorMoveCommands.line)', () => {
  const doc = Text.of(DOC.split('\n'));
  it('整行含换行:行首 → 下一行行首;最后一行到文末', () => {
    expect(wholeLinesRange(doc, 2, 2)).toEqual({ from: 4, to: 8 });
    expect(wholeLinesRange(doc, 5, 5)).toEqual({ from: 19, to: 23 });
    expect(wholeLinesRange(doc, 4, 2)).toEqual({ from: 4, to: 19 });
  });
  it('向下扩展锚点在起点行首、头在目标的下一行行首;向上锚点在起点区间末、头在目标行首;同一行 = 起点区间', () => {
    const start = wholeLinesRange(doc, 3, 3); // three\n = 8..14
    expect(extendLineSelection(doc, start, { from: 14, to: 18 })).toEqual({ anchor: 8, head: 19 });
    expect(extendLineSelection(doc, start, { from: 0, to: 3 })).toEqual({ anchor: 14, head: 0 });
    expect(extendLineSelection(doc, start, { from: 8, to: 13 })).toEqual({ anchor: 8, head: 14 });
  });
});

describe('行号栏鼠标', () => {
  it('单击行号 → 选中整行(含换行,光标在下一行行首),阻止浏览器原生选字并获得焦点', () => {
    const v = mount();
    pointAtLine(v, 2);
    const focus = vi.spyOn(v, 'focus');
    const e = press(v);
    release(v);
    expect(sel(v)).toEqual({ anchor: 4, head: 8, text: 'two\n', count: 1 });
    expect(e.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalled();
  });

  it('单击最后一行的行号 → 选到文末', () => {
    const v = mount();
    pointAtLine(v, 5);
    press(v);
    release(v);
    expect(sel(v).text).toBe('five');
  });

  it('按住拖动按行扩展:向下到第 4 行 / 拖回起始行 / 向上到第 1 行;松开后不再跟随', () => {
    const v = mount();
    const at = pointAtLine(v, 2);
    press(v);
    at(4);
    move(v);
    expect(sel(v)).toMatchObject({ anchor: 4, head: 19, text: 'two\nthree\nfour\n' });
    at(2);
    move(v);
    expect(sel(v)).toMatchObject({ anchor: 4, head: 8 });
    at(1);
    move(v);
    expect(sel(v)).toMatchObject({ anchor: 8, head: 0, text: 'one\ntwo\n' });
    release(v);
    at(5);
    move(v);
    expect(sel(v)).toMatchObject({ anchor: 8, head: 0 });
  });

  it('⇧ 单击:从光标处按行扩展;紧接在行号选行之后以那整行为起点', () => {
    const v = mount();
    v.dispatch({ selection: { anchor: 5 } }); // 第 2 行 t|wo
    const at = pointAtLine(v, 4);
    press(v, { shiftKey: true });
    release(v);
    expect(sel(v)).toMatchObject({ anchor: 5, head: 19 });

    at(4);
    press(v); // 行号选中第 4 行
    release(v);
    at(2);
    press(v, { shiftKey: true });
    release(v);
    expect(sel(v)).toMatchObject({ anchor: 19, head: 4, text: 'two\nthree\nfour\n' });
  });

  it('⌥ 单击另加一个选中该行的光标;⇧⌥ 单击把主光标换成该行', () => {
    const v = mount();
    v.dispatch({ selection: { anchor: 1 } });
    const at = pointAtLine(v, 3);
    press(v, { altKey: true });
    release(v);
    expect(v.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [1, 1],
      [8, 14],
    ]);
    at(5);
    press(v, { altKey: true, shiftKey: true });
    release(v);
    expect(v.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [1, 1],
      [19, 23],
    ]);
  });

  it('右键 / 中键不处理;mac 上 ⌃ 单击(右键菜单)不处理', () => {
    const v = mount();
    v.dispatch({ selection: { anchor: 1 } });
    pointAtLine(v, 3);
    press(v, { button: 2 });
    press(v, { button: 1 });
    expect(sel(v)).toMatchObject({ anchor: 1, head: 1 });
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    press(v, { ctrlKey: true });
    expect(sel(v)).toMatchObject({ anchor: 1, head: 1 });
  });

  it('折叠栏不受影响:在折叠栏按下不选行', () => {
    const v = mount();
    v.dispatch({ selection: { anchor: 1 } });
    pointAtLine(v, 3);
    v.dom.querySelector('.cm-foldGutter')!.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(sel(v)).toMatchObject({ anchor: 1, head: 1 });
  });

  it('gutter 不可选中文字(user-select: none)', () => {
    const v = mount();
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    const rule = css.split('}').find((r) => r.includes('.cm-gutters') && r.includes('user-select'));
    expect(rule).toMatch(/user-select:\s*none/);
    expect(gutter(v)).toBeTruthy();
  });
});
