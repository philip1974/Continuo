// @vitest-environment jsdom
// BDD: editor-text-commands 第 5 条 —— 折叠(editor.fold)折叠包住光标的最内层可折叠区域(VSCode 同),不只在区域首行有效;
// 已折叠的跳过取外一层;多光标各自处理;光标不藏进折叠内容。展开(editor.unfold)光标在折叠占位所在行即展开。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
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

const SRC = [
  'function a() {', // 1
  '  if (x) {', // 2
  '    foo();', // 3
  '  }', // 4
  '  bar();', // 5
  '}', // 6
  'function b() {', // 7
  '  baz();', // 8
  '}', // 9
  'const z = 1;', // 10
].join('\n');

const views: EditorView[] = [];

function mount(cursors: readonly number[]): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const state = EditorState.create({ doc: SRC, extensions: [codeEditorBasicSetup, codeEditorTextCommands(), javascript()] });
  const view = new EditorView({
    parent,
    state: state.update({
      selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
    }).state,
  });
  useEditorStore.getState().openTab(createTab('/w/a.js', SRC), { groupId: 'editor' });
  useEditorStore.getState().registerView('/w/a.js', view, 'editor');
  views.push(view);
  return view;
}

/** 第 n 行(1 起)行首偏移 col 处的位置。 */
const at = (line: number, col = 0) => EditorState.create({ doc: SRC }).doc.line(line).from + col;
/** 已折叠区域:[首行号, 末行号]。 */
const folds = (v: EditorView): [number, number][] => {
  const out: [number, number][] = [];
  foldedRanges(v.state).between(0, v.state.doc.length, (from, to) => {
    out.push([v.state.doc.lineAt(from).number, v.state.doc.lineAt(to).number]);
  });
  return out;
};
const fold = () => coApp.commands.execute('editor.fold');
const unfold = () => coApp.commands.execute('editor.unfold');

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());
beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useKeybindingsStore.setState({ overrides: {} });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
});
afterEach(() => {
  cleanup();
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = '';
});

describe('折叠:包住光标的最内层区域', () => {
  it('光标在函数体中间一行(不是首行)→ 折叠该函数', async () => {
    const v = mount([at(5, 3)]);
    await fold();
    expect(folds(v)).toEqual([[1, 6]]);
  });

  it('嵌套:光标在 if 块内 → 折叠 if;再折叠 → 跳过已折叠的 if,折叠外层函数', async () => {
    const v = mount([at(3, 6)]);
    await fold();
    expect(folds(v)).toEqual([[2, 4]]);
    await fold();
    // 外层函数折叠;里面的 if 仍保持折叠(VSCode 同,展开外层后它还是折着的)
    expect(folds(v)).toEqual([
      [1, 6],
      [2, 4],
    ]);
  });

  it('光标在区域首行 / 末行(`}` 所在行)→ 折叠该区域', async () => {
    const v = mount([at(2, 1)]);
    await fold();
    expect(folds(v)).toEqual([[2, 4]]);
    await unfold();
    v.dispatch({ selection: EditorSelection.cursor(at(4, 3)) });
    await fold();
    expect(folds(v)).toEqual([[2, 4]]);
  });

  it('多光标:各自折叠所在区域(同一区域只折一次)', async () => {
    const v = mount([at(5, 2), at(8, 2), at(5, 4)]);
    await fold();
    expect(folds(v)).toEqual([
      [1, 6],
      [7, 9],
    ]);
  });

  it('被折叠内容里的光标移到折叠起点(首行行尾),不藏在占位符后面', async () => {
    const v = mount([at(3, 6)]);
    await fold();
    expect(v.state.selection.main.head).toBe(EditorState.create({ doc: SRC }).doc.line(2).to);
    expect(folds(v)).toEqual([[2, 4]]);
  });

  it('不在任何可折叠区域里 → 不动', async () => {
    const v = mount([at(10, 3)]);
    await fold();
    expect(folds(v)).toEqual([]);
  });

  it('按键(Windows / Linux Ctrl+Shift+[)经注册表同样生效', () => {
    renderHook(() => useCommandHotkeys(coApp.commands));
    const v = mount([at(8, 2)]);
    v.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', keyCode: 219, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(folds(v)).toEqual([[7, 9]]);
  });
});

describe('展开:光标在折叠占位所在行', () => {
  it('折叠后光标在占位行 → 展开;多光标各自展开', async () => {
    const v = mount([at(5, 2), at(8, 2)]);
    await fold();
    expect(folds(v)).toHaveLength(2);
    await unfold();
    expect(folds(v)).toEqual([]);
  });
});
