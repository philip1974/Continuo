// @vitest-environment jsdom
// 代码编辑器按文档缩进:回车自动缩进 / Tab / ⌘] 插入的缩进与文件一致;设置 / 选择器改动即时生效。行为见同目录 README。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { runScopeHandlers, type EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor, languageDescriptionFor } from '../../panels/Editor/CodeEditor';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { installIndentationSync, setTabIndentation, useIndentationStore } from '../../panels/Editor/editor-indentation';
// ⌘] / ⌘[(editor.action.indentLines / outdentLines)的实现即 indentMore / indentLess(codemirror-text-commands RUNNERS)
import { indentMore } from '@codemirror/commands';

function open(path: string, content: string) {
  useEditorStore.getState().openTab(createTab(path, content));
  const onChange = (v: string) => useEditorStore.getState().updateContent(path, v);
  render(<CodeEditor tabId={path} value={content} fileName={path.slice(path.lastIndexOf('/') + 1)} onChange={onChange} />);
  const view = useEditorStore.getState().viewRefs.get(path) as EditorView;
  expect(view).toBeTruthy();
  return view;
}

const key = (view: EditorView, k: string, opts: KeyboardEventInit = {}) =>
  act(() => {
    expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key: k, ...opts }), 'editor')).toBe(true);
  });

/** 光标放到第 n 行行尾。 */
function cursorAtEndOfLine(view: EditorView, n: number) {
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(n).to) });
}

const lineText = (view: EditorView, n: number) => view.state.doc.line(n).text;

beforeAll(async () => {
  // Python 语言包(language-data 懒加载)先加载好,创建时即有语法缩进
  await languageDescriptionFor('a.py')!.load();
});

let offSync: (() => void) | null = null;
beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useSettingsValuesStore.setState({ values: {} });
  useIndentationStore.setState({ byTab: new Map() });
});
/** 卸载编辑器(先清 tab:卸载时不存视图快照 —— jsdom 无布局,量滚动会抛错)。 */
function unmountAll() {
  useEditorStore.setState({ tabs: [] });
  cleanup();
}

afterEach(() => {
  unmountAll();
  offSync?.();
  offSync = null;
});

describe('回车自动缩进按文档缩进', () => {
  it('4 空格 Python:冒号行尾回车 → 新行缩进 8 格(上一级 4 + 4)', () => {
    const view = open('/w/a.py', 'def f():\n    if x:\n        return 1\n');
    cursorAtEndOfLine(view, 2);
    key(view, 'Enter');
    expect(lineText(view, 3)).toBe('        ');
    // 函数体首行:回车 → 4 格
    cursorAtEndOfLine(view, 1);
    key(view, 'Enter');
    expect(lineText(view, 2)).toBe('    ');
  });

  it('tab 缩进 Python:回车插 tab,不混空格', () => {
    const view = open('/w/b.py', 'def f():\n\tif x:\n\t\treturn 1\n');
    cursorAtEndOfLine(view, 2);
    key(view, 'Enter');
    expect(lineText(view, 3)).toBe('\t\t');
  });

  it('4 空格 TS:块内回车缩进 4 格', () => {
    const view = open('/w/c.ts', 'function f() {\n    const a = 1;\n    if (a) {\n    }\n}\n');
    cursorAtEndOfLine(view, 3);
    key(view, 'Enter');
    expect(lineText(view, 4)).toBe('        ');
  });
});

describe('Tab / ⌘] 按文档缩进', () => {
  it('Makefile 规则下 Tab → 插 tab', () => {
    const view = open('/w/Makefile', 'all:\n\techo hi\nclean:\n');
    cursorAtEndOfLine(view, 3);
    key(view, 'Enter');
    key(view, 'Tab');
    expect(lineText(view, 4)).toMatch(/^\t+$/);
    expect(lineText(view, 4)).not.toContain(' ');
  });

  it('空 Makefile(无内容可推断)→ 语言默认 tab', () => {
    const view = open('/w/x.mk', '');
    key(view, 'Tab');
    expect(view.state.doc.toString()).toBe('\t');
  });

  it('4 空格文件 ⌘] 缩进一级 = 4 格,⇧Tab 反缩进', () => {
    const view = open('/w/d.ts', 'a\n    b\nc');
    cursorAtEndOfLine(view, 3);
    act(() => {
      indentMore(view);
    });
    expect(lineText(view, 3)).toBe('    c');
    key(view, 'Tab', { shiftKey: true });
    expect(lineText(view, 3)).toBe('c');
  });
});

describe('设置与按文档更改即时生效', () => {
  it('关闭检测 → 用默认值(4 空格);insertSpaces 关 → tab', () => {
    useSettingsValuesStore.setState({ values: { 'editor.detectIndentation': false } });
    let view = open('/w/e.py', 'def f():\n  return 1\n');
    cursorAtEndOfLine(view, 1);
    key(view, 'Enter');
    expect(lineText(view, 2)).toBe('    ');
    unmountAll();
    useSettingsValuesStore.setState({ values: { 'editor.detectIndentation': false, 'editor.insertSpaces': false } });
    view = open('/w/f.py', 'def f():\n    return 1\n');
    cursorAtEndOfLine(view, 1);
    key(view, 'Enter');
    expect(lineText(view, 2)).toBe('\t');
  });

  it('打开后改设置 → 已打开的编辑器即时按新设置', () => {
    offSync = installIndentationSync();
    const view = open('/w/g.ts', 'a\n');
    key(view, 'Tab');
    expect(lineText(view, 1)).toBe('    a');
    act(() => useSettingsValuesStore.setState({ values: { 'editor.tabSize': 2, 'editor.detectIndentation': false } }));
    key(view, 'Tab');
    expect(lineText(view, 1)).toBe('      a');
  });

  it('选择器对当前文档设定缩进 → 即时生效(tab 宽度同步)', () => {
    const view = open('/w/h.ts', 'a\n');
    act(() => setTabIndentation('/w/h.ts', { tabSize: 8, insertSpaces: false }));
    key(view, 'Tab');
    expect(lineText(view, 1)).toBe('\ta');
    expect(view.state.tabSize).toBe(8);
  });

  it('Markdown 源码模式同样按文档缩进', () => {
    const path = '/w/n.md';
    useEditorStore.getState().openTab(createTab(path, '- a\n    - b\n'));
    render(<CodeEditor tabId={path} value={'- a\n    - b\n'} fileName="n.md" forceLanguage="markdown" />);
    const view = useEditorStore.getState().viewRefs.get(path) as EditorView;
    view.dispatch({ selection: EditorSelection.cursor(0) });
    key(view, 'Tab');
    expect(lineText(view, 1)).toBe('    - a');
  });
});
