// @vitest-environment jsdom
// BDD: editor-goto-line 第 4 条 —— CodeMirror 键位去冲突(⌘⌥G 小面板去掉;Win/Linux 的 Ctrl+G 不再是查找下一个)。见同目录 README。
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { findNext, findPrevious, gotoLine } from '@codemirror/search';
import { codeEditorBasicSetup, withoutConflictingSearchKeys } from '../../panels/Editor/codemirror-basic-setup';

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) {
    v.dom.remove();
    v.destroy();
  }
});

function editor(): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: 'one\ntwo\nthree\n', extensions: codeEditorBasicSetup }),
    parent,
  });
  views.push(view);
  return view;
}

/** 在编辑区按键;返回 CodeMirror 是否处理了(preventDefault)。jsdom 非 mac:Mod = Ctrl。 */
function press(view: EditorView, init: KeyboardEventInit): boolean {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('Windows / Linux(jsdom:Mod = Ctrl)', () => {
  it('Ctrl+G 不被 CodeMirror 吞掉(不当查找下一个,冒泡给工作台的转到行)', () => {
    const view = editor();
    expect(press(view, { key: 'g', code: 'KeyG', keyCode: 71, ctrlKey: true })).toBe(false);
    expect(press(view, { key: 'G', code: 'KeyG', keyCode: 71, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(view.dom.querySelector('.cm-search')).toBeNull();
  });

  it('Ctrl+Alt+G 不再打开 CodeMirror 自带的转到行小面板', () => {
    const view = editor();
    expect(press(view, { key: 'g', code: 'KeyG', keyCode: 71, ctrlKey: true, altKey: true })).toBe(false);
    expect(view.dom.querySelector('.cm-panel')).toBeNull();
  });

  it('F3 / ⇧F3 仍是查找下一个 / 上一个', () => {
    const view = editor();
    expect(press(view, { key: 'F3', code: 'F3', keyCode: 114 })).toBe(true);
  });
});

describe('键表改写(纯函数,覆盖 mac)', () => {
  it('去掉 gotoLine;Mod-g 查找下一个 / 上一个只在 mac 保留;其余原样', () => {
    const other = { key: 'Mod-d', run: () => true };
    const out = withoutConflictingSearchKeys([
      { key: 'Mod-Alt-g', run: gotoLine },
      { key: 'Mod-g', run: findNext, shift: findPrevious, preventDefault: true, scope: 'editor search-panel' },
      { key: 'F3', run: findNext, shift: findPrevious },
      other,
    ]);
    expect(out.some((b) => b.run === gotoLine)).toBe(false);
    const modG = out.find((b) => b.mac === 'Mod-g');
    expect(modG).toMatchObject({ run: findNext, shift: findPrevious, preventDefault: true, scope: 'editor search-panel' });
    expect(modG?.key).toBeUndefined();
    expect(out.find((b) => b.key === 'F3')?.run).toBe(findNext);
    expect(out).toContain(other);
  });

  it('改写落在 basicSetup 那份键表上(升级 codemirror 后仍命中)', () => {
    const bindings = EditorState.create({ extensions: codeEditorBasicSetup }).facet(keymap).flat();
    expect(bindings.some((b) => b.run === gotoLine)).toBe(false);
    expect(bindings.some((b) => b.mac === 'Mod-g' && b.run === findNext)).toBe(true);
    expect(bindings.some((b) => b.key === 'Mod-z')).toBe(true); // 默认键表其余部分仍在
  });
});
