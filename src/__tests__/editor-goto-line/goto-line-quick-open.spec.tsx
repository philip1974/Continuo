// @vitest-environment jsdom
// BDD: editor-goto-line 第 3 条(测试环境界面语言为中文) —— Quick Open `:` 模式:实时预览、Enter 跳转、Esc 恢复、越界夹取、无编辑器提示。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';

vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(() => new Promise(() => {})),
}));
// jsdom 无布局:虚拟列表渲染全部行(同 quick-open-modal 规范)。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { openGotoLine } from '../../panels/Editor/editor-commands';

const TAB = '/w/a.ts';
const DOC = Array.from({ length: 50 }, (_, i) => `line ${i + 1} text`).join('\n');
let view: EditorView | null = null;

function mountEditor(): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({ state: EditorState.create({ doc: DOC, selection: EditorSelection.cursor(3) }), parent });
  useEditorStore.getState().openTab(createTab(TAB, DOC));
  useEditorStore.getState().registerView(TAB, v, 'editor');
  view = v;
  return v;
}

const cursorLine = (v: EditorView): number => v.state.doc.lineAt(v.state.selection.main.head).number;
const cursorColumn = (v: EditorView): number => {
  const head = v.state.selection.main.head;
  return head - v.state.doc.lineAt(head).from + 1;
};
const input = (): HTMLInputElement => screen.getByRole('combobox') as HTMLInputElement;
const type = (q: string): void => {
  fireEvent.change(input(), { target: { value: q } });
};

beforeEach(() => {
  // jsdom 无 Range 布局:CodeMirror 量尺寸时调用(同 editor-find-widget 规范)
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0, results: [], loading: false, scanFailed: false });
});

afterEach(() => {
  cleanup();
  if (view) {
    useEditorStore.getState().unregisterView(TAB, view);
    view.dom.remove();
    view.destroy();
    view = null;
  }
});

describe('Quick Open `:` 模式', () => {
  it('⌃G 打开 → 只有 `:` 时提示当前行与行数范围,不移动光标;无工作区也可用', () => {
    const v = mountEditor();
    openGotoLine();
    render(<QuickOpenModal />);
    expect(input().value).toBe(':');
    expect(screen.getByRole('status').textContent).toBe(
      '当前行：1，字符：4。键入要导航到的行号（介于 1 和 50 之间）。',
    );
    expect(cursorLine(v)).toBe(1);
  });

  it('键入行号 → 实时预览(光标移到该行,焦点留在输入框);Enter → 关闭并落到该行', async () => {
    const v = mountEditor();
    openGotoLine();
    render(<QuickOpenModal />);
    type(':30');
    expect(screen.getByRole('option').textContent).toBe('转到第 30 行。');
    await waitFor(() => expect(cursorLine(v)).toBe(30));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    await waitFor(() => expect(cursorLine(v)).toBe(30));
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(v.hasFocus).toBe(true);
  });

  it('`:行:列` → 落到该列', async () => {
    const v = mountEditor();
    openGotoLine();
    render(<QuickOpenModal />);
    type(':12:6');
    expect(screen.getByRole('option').textContent).toBe('转到第 12 行第 6 个字符。');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect([cursorLine(v), cursorColumn(v)]).toEqual([12, 6]));
  });

  it('行号越界 → 夹到最后一行', async () => {
    const v = mountEditor();
    openGotoLine();
    render(<QuickOpenModal />);
    type(':300');
    expect(screen.getByRole('option').textContent).toBe('转到第 50 行。');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(cursorLine(v)).toBe(50));
  });

  it('Esc 取消 → 光标回到打开前(预览过也回去)', async () => {
    const v = mountEditor();
    openGotoLine();
    render(<QuickOpenModal />);
    type(':40');
    await waitFor(() => expect(cursorLine(v)).toBe(40));
    act(() => useQuickOpenStore.getState().close());
    expect(v.state.selection.main.head).toBe(3);
  });

  it('删掉 `:` 回到文件搜索 → 光标同样回到原位', async () => {
    const v = mountEditor();
    openGotoLine();
    render(<QuickOpenModal />);
    type(':40');
    await waitFor(() => expect(cursorLine(v)).toBe(40));
    type('40');
    expect(v.state.selection.main.head).toBe(3);
  });

  it('没有活动文本编辑器 → 提示先打开文本编辑器,Enter 无动作', () => {
    openGotoLine();
    render(<QuickOpenModal />);
    type(':5');
    expect(screen.getByRole('status').textContent).toBe('请先打开文本编辑器，然后再转到行。');
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
  });
});
