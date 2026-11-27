// @vitest-environment jsdom
// BDD: markdown-outline 第 3 条(测试环境界面语言为中文)—— Quick Open `@` 模式:列表 / 分组标签 / 初始选中 / 过滤 / 预览 / Enter / Esc /
// 提示;源码(CodeMirror)与编辑 / 预览(Milkdown 视图句柄)。见同目录 README。
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
import { openGotoSymbol } from '../../panels/Editor/editor-commands';
import { navigationStack, resetNavigationHistory } from '../../panels/Editor/navigation-history';
import { navigationHistoryExtension } from '../../panels/Editor/codemirror-navigation-history';
import {
  __resetMarkdownOutlineForTest,
  registerMarkdownOutline,
  type MarkdownOutlineHandle,
} from '../../panels/Editor/markdown-outline-registry';

const MD = '/w/notes.md';
const DOC = [
  '# Intro', //      1
  'text', //         2
  '## Setup', //     3
  'a', //            4
  'b', //            5
  '## Gamma rays', // 6
  'c', //            7
  '# Usage', //      8
  ...Array.from({ length: 20 }, (_, i) => `body ${i}`), // 9–28
  '# Appendix', //  29
  ...Array.from({ length: 20 }, (_, i) => `more ${i}`),
].join('\n');
const views: EditorView[] = [];

function mountEditor(path = MD, doc = DOC, cursorLine = 4): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({ doc });
  const v = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(state.doc.line(cursorLine).from + 1),
      extensions: navigationHistoryExtension(path, 'editor'),
    }),
    parent,
  });
  useEditorStore.getState().openTab(createTab(path, doc));
  useEditorStore.getState().registerView(path, v, 'editor');
  views.push(v);
  return v;
}

const cursorLine = (v: EditorView): number => v.state.doc.lineAt(v.state.selection.main.head).number;
const input = (): HTMLInputElement => screen.getByRole('combobox') as HTMLInputElement;
const type = (q: string): void => {
  fireEvent.change(input(), { target: { value: q } });
};
const optionTexts = (): string[] => screen.queryAllByRole('option').map((o) => o.textContent ?? '');
const selectedOption = (): string | undefined =>
  screen.queryAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.textContent ?? undefined;
const nextFrame = () => act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
    mode: 'source',
  });
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0, results: [], loading: false, scanFailed: false });
  resetNavigationHistory();
});

afterEach(() => {
  cleanup();
  for (const v of views.splice(0)) {
    v.dom.remove();
    v.destroy();
  }
  __resetMarkdownOutlineForTest();
});

describe('源码模式(CodeMirror)', () => {
  it('⇧⌘O → `@`:列出标题(名称 + 上级标题),首行「符号（N）」;初始选中光标所在的节,编辑器不动', async () => {
    const v = mountEditor();
    openGotoSymbol();
    render(<QuickOpenModal />);
    expect(input().value).toBe('@');
    await waitFor(() => expect(optionTexts()).toHaveLength(5));
    expect(optionTexts()).toEqual(['# Intro符号（5）', '## Setup# Intro', '## Gamma rays# Intro', '# Usage', '# Appendix']);
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('符号');
    await waitFor(() => expect(selectedOption()).toBe('## Setup# Intro'));
    expect(cursorLine(v)).toBe(4);
  });

  it('`@:` 按类别:首行「字符串（N）」', async () => {
    mountEditor();
    openGotoSymbol();
    render(<QuickOpenModal />);
    type('@:');
    await waitFor(() => expect(optionTexts()[0]).toBe('# Intro字符串（5）'));
  });

  it('过滤 → 首个命中预览(光标到标题、焦点留在输入框);↓ 跟随;Esc → 光标回原处', async () => {
    const v = mountEditor();
    openGotoSymbol();
    render(<QuickOpenModal />);
    await waitFor(() => expect(optionTexts()).toHaveLength(5));
    input().focus();
    type('@s');
    await waitFor(() => expect(optionTexts().map((t) => t.split('#').filter(Boolean)[0]?.trim())).toEqual(['Setup', 'Gamma rays', 'Usage']));
    await waitFor(() => expect(cursorLine(v)).toBe(3));
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    await waitFor(() => expect(cursorLine(v)).toBe(6));
    act(() => useQuickOpenStore.getState().close());
    expect(cursorLine(v)).toBe(4);
    expect(navigationStack().entries).toHaveLength(0); // 预览与恢复不记导航
  });

  it('Enter → 关闭、光标到标题并聚焦编辑器;记导航「原位置 → 标题」', async () => {
    const v = mountEditor();
    openGotoSymbol();
    render(<QuickOpenModal />);
    type('@appendix');
    await waitFor(() => expect(optionTexts()).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    await nextFrame();
    await waitFor(() => expect(cursorLine(v)).toBe(29));
    expect(v.hasFocus).toBe(true);
    expect(navigationStack().entries.map((e) => e.selection?.line)).toEqual([4, 29]);
  });

  it('删掉 `@` 回到文件搜索 → 光标回原处', async () => {
    const v = mountEditor();
    openGotoSymbol();
    render(<QuickOpenModal />);
    type('@gam');
    await waitFor(() => expect(cursorLine(v)).toBe(6));
    type('gam');
    expect(cursorLine(v)).toBe(4);
  });

  it('⌘P 里键入 `@` 同样进入该模式', async () => {
    mountEditor();
    act(() => useQuickOpenStore.getState().open());
    render(<QuickOpenModal />);
    type('@');
    await waitFor(() => expect(optionTexts()).toHaveLength(5));
  });
});

describe('提示(VSCode 同款)', () => {
  it('没有编辑器 → 先打开文本编辑器;Enter 无动作', () => {
    openGotoSymbol();
    render(<QuickOpenModal />);
    expect(screen.getByRole('status').textContent).toBe('若要转到符号，请先打开包含符号信息的文本编辑器。');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
  });

  it('非 Markdown(无语言服务)→ 不提供符号信息', () => {
    mountEditor('/w/a.ts', 'const a = 1;\n# not md\n', 1);
    openGotoSymbol();
    render(<QuickOpenModal />);
    expect(screen.getByRole('status').textContent).toBe('活动文本编辑器不提供符号信息。');
  });

  it('没有标题 → 没有编辑器符号;无匹配 → 没有匹配的编辑器符号', async () => {
    mountEditor('/w/plain.md', 'just text\n', 1);
    openGotoSymbol();
    render(<QuickOpenModal />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('没有编辑器符号'));
    cleanup();
    mountEditor();
    openGotoSymbol();
    render(<QuickOpenModal />);
    type('@zzz');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('没有匹配的编辑器符号'));
  });
});

describe('编辑 / 预览模式(Milkdown 视图句柄)', () => {
  function fakeHandle(current: number) {
    const restore = vi.fn();
    const handle: MarkdownOutlineHandle = {
      currentHeading: vi.fn(() => current),
      revealHeading: vi.fn(() => true),
      snapshot: vi.fn(() => restore),
    };
    return { handle, restore };
  }

  for (const mode of ['edit', 'preview'] as const) {
    it(`${mode}:初始选中当前节;移动 → 按标题序号预览(不聚焦);Esc → 恢复快照`, async () => {
      useEditorStore.setState({ mode });
      useEditorStore.getState().openTab(createTab(MD, DOC));
      const { handle, restore } = fakeHandle(2);
      registerMarkdownOutline(MD, 'editor', handle);
      openGotoSymbol();
      render(<QuickOpenModal />);
      await waitFor(() => expect(selectedOption()).toBe('## Gamma rays# Intro'));
      expect(handle.revealHeading).not.toHaveBeenCalled();
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
      await waitFor(() => expect(handle.revealHeading).toHaveBeenLastCalledWith(3, { focus: false }));
      act(() => useQuickOpenStore.getState().close());
      expect(restore).toHaveBeenCalledTimes(1);
    });
  }

  it('Enter → 定位并聚焦(下一帧),不恢复快照', async () => {
    useEditorStore.setState({ mode: 'edit' });
    useEditorStore.getState().openTab(createTab(MD, DOC));
    const { handle, restore } = fakeHandle(0);
    registerMarkdownOutline(MD, 'editor', handle);
    openGotoSymbol();
    render(<QuickOpenModal />);
    type('@setup');
    await waitFor(() => expect(optionTexts()).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await nextFrame();
    expect(handle.revealHeading).toHaveBeenLastCalledWith(1, { focus: true });
    expect(restore).not.toHaveBeenCalled();
  });
});
