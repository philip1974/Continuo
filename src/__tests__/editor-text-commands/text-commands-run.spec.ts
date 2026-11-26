// @vitest-environment jsdom
// BDD: editor-text-commands 第 2 / 3 条 —— 作用于触发窗口活动编辑器组的 CodeMirror 视图、各命令效果、无编辑器静默、
// 按键经注册表分发(CodeMirror 键表不再处理这些键)。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';
import { foldedRanges } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { useCommandHotkeys } from '@/plugins/command-palette/useCommandHotkeys';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { codeEditorBasicSetup } from '@/panels/Editor/codemirror-basic-setup';
import { codeEditorTextCommands } from '@/panels/Editor/codemirror-text-commands';

const views: { tabId: string; view: EditorView }[] = [];

function mount(tabId: string, doc: string, groupId = 'editor', anchor = 0, head = anchor): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [codeEditorBasicSetup, codeEditorTextCommands(), javascript()],
    }),
    parent,
  });
  useEditorStore.getState().openTab(createTab(tabId, doc), { groupId });
  useEditorStore.getState().registerView(tabId, view, groupId);
  views.push({ tabId, view });
  return view;
}

const run = (id: string): Promise<void> => coApp.commands.execute(id);
const text = (v: EditorView): string => v.state.doc.toString();
const sel = (v: EditorView): readonly [number, number][] => v.state.selection.ranges.map((r) => [r.from, r.to]);

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useKeybindingsStore.setState({ overrides: {} });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [
      { id: 'editor', tabIds: [], activeTabId: null },
      { id: 'editor-2', tabIds: [], activeTabId: null },
    ],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
});

afterEach(() => {
  cleanup();
  for (const { tabId, view } of views.splice(0)) {
    useEditorStore.getState().unregisterView(tabId, view);
    view.destroy();
  }
  document.body.innerHTML = '';
});

describe('作用于活动编辑器组的活动文本编辑器', () => {
  it('切换行注释 / 块注释', async () => {
    const v = mount('/w/a.js', 'let a = 1;');
    await run('editor.action.commentLine');
    expect(text(v)).toBe('// let a = 1;');
    await run('editor.action.commentLine');
    expect(text(v)).toBe('let a = 1;');
    v.dispatch({ selection: EditorSelection.single(0, 10) });
    await run('editor.action.blockComment');
    expect(text(v)).toBe('/* let a = 1; */');
  });

  it('上移 / 下移行,向上 / 向下复制行,删除行', async () => {
    const v = mount('/w/a.js', 'a\nb\nc', 'editor', 2); // 光标在 b
    await run('editor.action.moveLinesUpAction');
    expect(text(v)).toBe('b\na\nc');
    await run('editor.action.moveLinesDownAction');
    expect(text(v)).toBe('a\nb\nc');
    await run('editor.action.copyLinesDownAction');
    expect(text(v)).toBe('a\nb\nb\nc');
    await run('editor.action.deleteLines');
    expect(text(v)).toBe('a\nb\nc');
    v.dispatch({ selection: EditorSelection.cursor(0) });
    await run('editor.action.copyLinesUpAction');
    expect(text(v)).toBe('a\na\nb\nc');
    expect(sel(v)).toEqual([[0, 0]]);
  });

  it('在下方 / 上方插入行(保持缩进,光标落在新行)', async () => {
    const v = mount('/w/a.js', 'x\n  yy', 'editor', 5); // 光标在 yy 中间
    await run('editor.action.insertLineBefore');
    expect(text(v)).toBe('x\n  \n  yy');
    expect(sel(v)).toEqual([[4, 4]]);
    v.dispatch({ selection: EditorSelection.cursor(0) });
    await run('editor.action.insertLineAfter');
    expect(text(v)).toBe('x\n\n  \n  yy');
    expect(sel(v)).toEqual([[2, 2]]);
  });

  it('缩进 / 减少缩进', async () => {
    const v = mount('/w/a.js', 'a', 'editor', 1);
    await run('editor.action.indentLines');
    expect(text(v)).toBe('  a');
    await run('editor.action.outdentLines');
    expect(text(v)).toBe('a');
  });

  it('添加下一个匹配到选区 / 选择所有匹配(空选区先取光标处单词)', async () => {
    const v = mount('/w/a.js', 'foo bar foo foo', 'editor', 1);
    await run('editor.action.addSelectionToNextFindMatch');
    expect(sel(v)).toEqual([[0, 3]]);
    await run('editor.action.addSelectionToNextFindMatch');
    expect(sel(v)).toEqual([
      [0, 3],
      [8, 11],
    ]);
    v.dispatch({ selection: EditorSelection.cursor(1) });
    await run('editor.action.selectHighlights');
    expect(sel(v)).toHaveLength(3);
  });

  it('选中行(连按向下扩展),撤销光标', async () => {
    const v = mount('/w/a.js', 'one\ntwo\nthree', 'editor', 1);
    await run('expandLineSelection');
    expect(sel(v)).toEqual([[0, 4]]);
    await run('expandLineSelection');
    expect(sel(v)).toEqual([[0, 8]]);
    v.dispatch({ selection: EditorSelection.cursor(9) }); // three 中间
    await run('expandLineSelection');
    expect(sel(v)).toEqual([[8, 13]]); // 末行:到文档末尾
    await run('cursorUndo');
    expect(sel(v)).toEqual([[9, 9]]);
  });

  it('折叠 / 展开 / 全部折叠 / 全部展开,跳到匹配括号', async () => {
    const v = mount('/w/a.js', 'function f() {\n  return 1;\n}\n', 'editor', 14);
    await run('editor.fold');
    expect(foldedRanges(v.state).size).toBe(1);
    await run('editor.unfold');
    expect(foldedRanges(v.state).size).toBe(0);
    await run('editor.foldAll');
    expect(foldedRanges(v.state).size).toBe(1);
    await run('editor.unfoldAll');
    expect(foldedRanges(v.state).size).toBe(0);
    v.dispatch({ selection: EditorSelection.cursor(13) }); // `{` 前
    await run('editor.action.jumpToBracket');
    expect(v.state.selection.main.head).toBe(28); // 匹配的 `}` 之后
  });

  it('多个编辑器组:作用于活动组的视图,不动另一组', async () => {
    const a = mount('/w/a.js', 'a');
    const b = mount('/w/b.js', 'b', 'editor-2');
    useEditorStore.setState({ activeGroupId: 'editor-2' });
    await run('editor.action.commentLine');
    expect(text(a)).toBe('a');
    expect(text(b)).toBe('// b');
  });

  it('没有文本编辑器 → 静默(不抛、不改动)', async () => {
    await expect(run('editor.action.commentLine')).resolves.toBeUndefined();
    await expect(run('editor.foldAll')).resolves.toBeUndefined();
  });
});

describe('按键经注册表分发(Windows / Linux:mod = Ctrl)', () => {
  const press = (target: EventTarget, init: KeyboardEventInit): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  it('CodeMirror 键表不再处理这些键(交给注册表分发);撤销等其它键照旧', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc: 'a\nb', extensions: codeEditorBasicSetup }), parent });
    try {
      for (const init of [
        { key: '/', code: 'Slash', keyCode: 191, ctrlKey: true },
        { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, altKey: true },
        { key: 'l', code: 'KeyL', keyCode: 76, altKey: true },
        { key: 'd', code: 'KeyD', keyCode: 68, ctrlKey: true },
        { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true },
        { key: ']', code: 'BracketRight', keyCode: 221, ctrlKey: true },
        { key: 'u', code: 'KeyU', keyCode: 85, ctrlKey: true },
        { key: '[', code: 'BracketLeft', keyCode: 219, ctrlKey: true, shiftKey: true },
      ]) {
        expect(press(view.contentDOM, init).defaultPrevented, JSON.stringify(init)).toBe(false);
      }
      expect(press(view.contentDOM, { key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true }).defaultPrevented).toBe(true);
      const bindings = EditorState.create({ extensions: codeEditorBasicSetup }).facet(keymap).flat();
      expect(bindings.some((b) => b.key === 'Mod-z')).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it('编辑器正文里按 Ctrl+/ → 切换注释;改键后新键生效、旧键失效', () => {
    renderHook(() => useCommandHotkeys(coApp.commands));
    const v = mount('/w/a.js', 'x');
    press(v.contentDOM, { key: '/', code: 'Slash', keyCode: 191, ctrlKey: true });
    expect(text(v)).toBe('// x');

    cleanup();
    useKeybindingsStore.setState({ overrides: { 'editor.action.commentLine': 'mod+shift+7' } });
    renderHook(() => useCommandHotkeys(coApp.commands));
    press(v.contentDOM, { key: '/', code: 'Slash', keyCode: 191, ctrlKey: true });
    expect(text(v)).toBe('// x');
    press(v.contentDOM, { key: '&', code: 'Digit7', keyCode: 55, ctrlKey: true, shiftKey: true });
    expect(text(v)).toBe('x');
  });

  it('Milkdown 代码块里的 CodeMirror(非 CodeEditor)按 Ctrl+/ → 不动', () => {
    renderHook(() => useCommandHotkeys(coApp.commands));
    const pm = document.createElement('div');
    pm.className = 'ProseMirror';
    document.body.appendChild(pm);
    const block = new EditorView({ state: EditorState.create({ doc: 'x', extensions: [javascript()] }), parent: pm });
    const editor = mount('/w/a.js', 'y');
    try {
      press(block.contentDOM, { key: '/', code: 'Slash', keyCode: 191, ctrlKey: true });
      expect(block.state.doc.toString()).toBe('x');
      expect(text(editor)).toBe('y');
    } finally {
      block.destroy();
    }
  });
});
