// @vitest-environment jsdom
// BDD: editor-mouse-multicursor —— ⌥ 单击添加光标、⌘ / Ctrl 单击不加、⇧⌥ 拖动列选择、无十字光标。见同目录 README。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { codeEditorBasicSetup } from '@/panels/Editor/codemirror-basic-setup';

const views: EditorView[] = [];
beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
});
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = '';
});

function mount(ext: Extension): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc: 'abc\ndef\n', extensions: ext }), parent });
  views.push(view);
  return view;
}

const mouse = (init: MouseEventInit): MouseEvent => new MouseEvent('mousedown', { button: 0, ...init });

/** 单击是否添加选区(CodeMirror 取 clickAddsSelectionRange 第一项;无则 mac ⌘ / 其它 Ctrl)。 */
function addsRange(view: EditorView, e: MouseEvent): boolean {
  const facet = view.state.facet(EditorView.clickAddsSelectionRange);
  return facet.length > 0 ? facet[0]!(e) : e.ctrlKey;
}

/** 按下是否进入列选择(某个 mouseSelectionStyle 接手)。 */
function startsColumnSelect(view: EditorView, e: MouseEvent): boolean {
  return view.state.facet(EditorView.mouseSelectionStyle).some((style) => style(view, e) !== null);
}

describe('多光标修饰键 = ⌥(VSCode multiCursorModifier 默认 alt)', () => {
  it('⌥ 单击添加光标;⌘ / Ctrl 单击、⇧⌥、⌥⌘ 不添加', () => {
    const v = mount(codeEditorBasicSetup);
    expect(addsRange(v, mouse({ altKey: true }))).toBe(true);
    expect(addsRange(v, mouse({ metaKey: true }))).toBe(false);
    expect(addsRange(v, mouse({ ctrlKey: true }))).toBe(false);
    expect(addsRange(v, mouse({ altKey: true, shiftKey: true }))).toBe(false);
    expect(addsRange(v, mouse({ altKey: true, metaKey: true }))).toBe(false);
    expect(addsRange(v, mouse({}))).toBe(false);
  });

  it('⌥ 单击 / 拖动不再是列选择(此前会清掉其它光标);⇧⌥ 拖动才是', () => {
    const v = mount(codeEditorBasicSetup);
    expect(startsColumnSelect(v, mouse({ altKey: true }))).toBe(false);
    expect(startsColumnSelect(v, mouse({}))).toBe(false);
    expect(startsColumnSelect(v, mouse({ shiftKey: true }))).toBe(false);
    expect(startsColumnSelect(v, mouse({ altKey: true, shiftKey: true, button: 2 }))).toBe(false);
    expect(startsColumnSelect(v, mouse({ altKey: true, shiftKey: true }))).toBe(true);
  });

  it('对照:CodeMirror 原 basicSetup 是 ⌥ 列选择(本规范有鉴别力)', () => {
    const v = mount(basicSetup);
    expect(startsColumnSelect(v, mouse({ altKey: true }))).toBe(true);
  });

  it('按住 ⌥ 不显示十字光标(CodeMirror 列选择提示,VSCode 没有)', () => {
    const press = (view: EditorView) =>
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', keyCode: 18, altKey: true, bubbles: true }));
    const ours = mount(codeEditorBasicSetup);
    press(ours);
    expect(ours.contentDOM.style.cursor).not.toBe('crosshair');
    const original = mount(basicSetup);
    press(original);
    expect(original.contentDOM.style.cursor).toBe('crosshair');
  });
});
