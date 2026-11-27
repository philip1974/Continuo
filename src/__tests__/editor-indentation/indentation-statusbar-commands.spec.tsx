// @vitest-environment jsdom
// 状态栏缩进项、缩进选择器、5 个命令(使用空格 / Tab 缩进、检测、转换)。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { runScopeHandlers, type EditorView } from '@codemirror/view';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { createTab, useEditorStore, type EditorTab } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { useEncodingPickerStore } from '../../plugins/editor-encoding/store';
import { acceptEncodingPick } from '../../plugins/editor-encoding/encoding-actions';
import { encodingPickItems } from '../../plugins/editor-encoding/encoding-picks';
import {
  convertIndentation,
  detectIndentation,
  indentationCommandSpecs,
} from '../../plugins/editor-encoding/indentation-actions';
import {
  convertIndentationText,
  installIndentationSync,
  setTabIndentation,
  tabIndentationOf,
  useIndentationStore,
} from '../../panels/Editor/editor-indentation';
import { setLocale } from '../../i18n';

function setTab(tab: Partial<EditorTab> & { filePath: string; content: string }) {
  useEditorStore.setState({
    tabs: [{ id: tab.filePath, originalContent: tab.content, dirty: false, ...tab }],
    activeTabId: tab.filePath,
  });
}

const indentItem = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('[data-statusbar-indentation]');

beforeEach(() => {
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
  captureLmApi();
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEncodingPickerStore.getState().close();
  useSettingsValuesStore.setState({ values: {} });
  useIndentationStore.setState({ byTab: new Map() });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'source' });
  setLocale('en');
});
afterEach(() => {
  useEditorStore.setState({ tabs: [] });
  cleanup();
  delete (window as { api?: unknown }).api;
});

describe('状态栏缩进项', () => {
  it('显示「Spaces: 4」/「Tab Size: 4」(zh 全角冒号「空格：4」),三语;位于编码项之前', () => {
    setTab({ filePath: '/w/a.py', content: 'x' });
    setTabIndentation('/w/a.py', { tabSize: 4, insertSpaces: true });
    const { container } = render(<StatusBar />);
    expect(indentItem(container)?.textContent).toBe('Spaces: 4');
    expect(indentItem(container)?.title).toBe('Select Indentation');
    const enc = container.querySelector('[data-statusbar-encoding]')!;
    expect(indentItem(container)!.compareDocumentPosition(enc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => setTabIndentation('/w/a.py', { tabSize: 8, insertSpaces: false }));
    expect(indentItem(container)?.textContent).toBe('Tab Size: 8');
    // setLocale 不广播(界面语言切换走设置);重新渲染取新语言
    const again = () => {
      cleanup();
      return render(<StatusBar />).container;
    };
    setLocale('zh');
    expect(indentItem(again())?.textContent).toBe('制表符长度：8');
    setTabIndentation('/w/a.py', { tabSize: 2, insertSpaces: true });
    expect(indentItem(again())?.textContent).toBe('空格：2');
    setLocale('ko');
    expect(indentItem(again())?.textContent).toBe('공백: 2');
    setTabIndentation('/w/a.py', { tabSize: 4, insertSpaces: false });
    expect(indentItem(again())?.textContent).toBe('탭 크기: 4');
  });

  it('代码编辑器打开文档 → 显示推断出的缩进', () => {
    const path = '/w/b.py';
    useEditorStore.getState().openTab(createTab(path, 'def f():\n\treturn 1\n'));
    render(<CodeEditor tabId={path} value={'def f():\n\treturn 1\n'} fileName="b.py" />);
    const { container } = render(<StatusBar />);
    expect(indentItem(container)?.textContent).toBe('Tab Size: 4');
  });

  it('Markdown 编辑模式(Milkdown)/ 图片 tab / 未确定缩进 → 不显示', () => {
    setTab({ filePath: '/w/n.md', content: '# a' });
    setTabIndentation('/w/n.md', { tabSize: 4, insertSpaces: true });
    act(() => useEditorStore.setState({ mode: 'edit' }));
    let c = render(<StatusBar />).container;
    expect(indentItem(c)).toBeNull();
    act(() => useEditorStore.setState({ mode: 'source' }));
    expect(indentItem(c)?.textContent).toBe('Spaces: 4');
    cleanup();
    setTab({ filePath: '/w/p.png', content: '1:2:3' });
    setTabIndentation('/w/p.png', { tabSize: 4, insertSpaces: true });
    c = render(<StatusBar />).container;
    expect(indentItem(c)).toBeNull();
    cleanup();
    setTab({ filePath: '/w/q.txt', content: '' });
    c = render(<StatusBar />).container;
    expect(indentItem(c)).toBeNull();
  });

  it('点击 → 动作选择器;使用空格缩进 → 选宽度(选中当前)→ 对当前文档生效', () => {
    setTab({ filePath: '/w/a.py', content: 'x' });
    setTabIndentation('/w/a.py', { tabSize: 4, insertSpaces: false });
    const { container } = render(<StatusBar />);
    act(() => fireEvent.click(indentItem(container)!));
    const req = useEncodingPickerStore.getState().request!;
    expect(req).toEqual({ kind: 'indent', tabId: '/w/a.py' });
    expect(encodingPickItems(req).items.map((i) => i.id)).toEqual([
      'editor.action.indentUsingSpaces',
      'editor.action.indentUsingTabs',
      'editor.action.detectIndentation',
      'editor.action.indentationToSpaces',
      'editor.action.indentationToTabs',
    ]);
    act(() => acceptEncodingPick(req, 'editor.action.indentUsingSpaces'));
    const sizeReq = useEncodingPickerStore.getState();
    expect(sizeReq).toMatchObject({
      isOpen: true,
      request: { kind: 'indent-size', tabId: '/w/a.py', insertSpaces: true },
      selectedIndex: 3,
    });
    act(() => acceptEncodingPick(sizeReq.request!, '2'));
    expect(useEncodingPickerStore.getState().isOpen).toBe(false);
    expect(tabIndentationOf('/w/a.py')).toEqual({ tabSize: 2, insertSpaces: true });
    expect(indentItem(container)?.textContent).toBe('Spaces: 2');
  });

  it('宽度项标注已配置 / 默认 / 当前制表符大小(VSCode 同)', () => {
    const req = { kind: 'indent-size', tabId: '/w/a', insertSpaces: true } as const;
    const d = (cur: number, conf: number) =>
      encodingPickItems(req, { indent: { tabSize: cur, insertSpaces: true }, configuredTabSize: conf }).items.map(
        (i) => i.descriptionKey ?? null,
      );
    expect(d(4, 4)[3]).toBe('encoding_picker.configured_tab_size');
    const mixed = d(2, 4);
    expect(mixed[1]).toBe('encoding_picker.current_tab_size');
    expect(mixed[3]).toBe('encoding_picker.default_tab_size');
    expect(mixed.filter((x) => x !== null)).toHaveLength(2);
    expect(encodingPickItems(req, { indent: { tabSize: 12, insertSpaces: true } }).selectedIndex).toBe(7);
  });
});

describe('命令', () => {
  it('命令 id / 英文标题同 VSCode,有三语标题 key', () => {
    expect(indentationCommandSpecs().map((s) => [s.id, s.title])).toEqual([
      ['editor.action.indentUsingSpaces', 'Indent Using Spaces'],
      ['editor.action.indentUsingTabs', 'Indent Using Tabs'],
      ['editor.action.detectIndentation', 'Detect Indentation from Content'],
      ['editor.action.indentationToSpaces', 'Convert Indentation to Spaces'],
      ['editor.action.indentationToTabs', 'Convert Indentation to Tabs'],
    ]);
    for (const s of indentationCommandSpecs()) expect(s.titleKey).toMatch(/^commands\.editor\./);
  });

  it('从内容中检测:按当前内容重新推断(设置关了检测也推断)', () => {
    useSettingsValuesStore.setState({ values: { 'editor.detectIndentation': false } });
    setTab({ filePath: '/w/a.py', content: 'def f():\n  return 1\n' });
    setTabIndentation('/w/a.py', { tabSize: 4, insertSpaces: false });
    detectIndentation('/w/a.py');
    expect(tabIndentationOf('/w/a.py')).toEqual({ tabSize: 2, insertSpaces: true });
  });

  it('转换缩进(无视图):转空格 / 转 tab,行尾保留,余下不足一级的空格保留', () => {
    expect(convertIndentationText('a\r\n\tb\r\n\t\t  c\r\n', 4, true)).toBe('a\r\n    b\r\n          c\r\n');
    expect(convertIndentationText('a\n    b\n          c\n  \n', 4, false)).toBe('a\n\tb\n\t\t  c\n  \n');
    setTab({ filePath: '/w/m.txt', content: 'a\n\tb\n' });
    setTabIndentation('/w/m.txt', { tabSize: 2, insertSpaces: false });
    convertIndentation(true, '/w/m.txt');
    expect(useEditorStore.getState().tabs[0]!.content).toBe('a\n  b\n');
    expect(tabIndentationOf('/w/m.txt')).toEqual({ tabSize: 2, insertSpaces: true });
  });

  it('转换缩进(编辑器挂着):一次撤销撤回,之后改用 tab', () => {
    const path = '/w/c.py';
    const original = 'def f():\n    if x:\n        return 1\n';
    useEditorStore.getState().openTab(createTab(path, original));
    render(
      <CodeEditor
        tabId={path}
        value={original}
        fileName="c.py"
        onChange={(v) => useEditorStore.getState().updateContent(path, v)}
      />,
    );
    const view = useEditorStore.getState().viewRefs.get(path) as EditorView;
    view.dispatch({ changes: { from: 0, insert: '#' }, userEvent: 'input.type' });
    act(() => convertIndentation(false, path));
    expect(view.state.doc.toString()).toBe('#def f():\n\tif x:\n\t\treturn 1\n');
    expect(tabIndentationOf(path)).toEqual({ tabSize: 4, insertSpaces: false });
    const isMac = /Mac/.test(navigator.platform);
    act(() => {
      runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'z', metaKey: isMac, ctrlKey: !isMac }), 'editor');
    });
    expect(view.state.doc.toString()).toBe(`#${original}`);
  });

  it('设置变化 → 已打开文档重定;文档关闭 → 丢弃记录', () => {
    const off = installIndentationSync();
    try {
      setTab({ filePath: '/w/a.ts', content: 'a\n' });
      setTabIndentation('/w/a.ts', { tabSize: 8, insertSpaces: false });
      act(() => useSettingsValuesStore.setState({ values: { 'editor.tabSize': 3 } }));
      expect(tabIndentationOf('/w/a.ts')).toEqual({ tabSize: 3, insertSpaces: true });
      act(() => useEditorStore.setState({ tabs: [] }));
      expect(tabIndentationOf('/w/a.ts')).toBeUndefined();
    } finally {
      off();
    }
  });
});
