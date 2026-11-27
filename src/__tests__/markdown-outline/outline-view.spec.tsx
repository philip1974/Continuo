// @vitest-environment jsdom
// BDD: markdown-outline 第 4 条(测试环境界面语言为中文)—— 侧栏大纲视图:分区展开、空状态、读屏语义、跟随光标、单击 / 键盘跳转、
// 过滤、菜单(跟随光标 / 排序)、全部折叠、聚焦命令、编辑后重解析、Milkdown 视图。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 22,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 22, size: 22, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { OutlineSection } from '@/panels/Outline/OutlineView';
import { __resetOutlineStoreForTest, useOutlineStore } from '@/panels/Outline/outline-store';
import { focusOutlineView } from '@/panels/Outline/outline-commands';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { navigationHistoryExtension } from '@/panels/Editor/codemirror-navigation-history';
import { navigationStack, resetNavigationHistory } from '@/panels/Editor/navigation-history';
import {
  __resetMarkdownOutlineForTest,
  registerMarkdownOutline,
  type MarkdownOutlineHandle,
} from '@/panels/Editor/markdown-outline-registry';

const MD = '/w/notes.md';
const DOC = [
  '# Intro', //       1
  'text', //          2
  '## Setup', //      3
  'a', //             4
  '## Gamma rays', // 5
  'c', //             6
  ...Array.from({ length: 20 }, (_, i) => `body ${i}`), // 7–26
  '# Usage', //       27
  'u', //             28
].join('\n');
const views: EditorView[] = [];

function mountEditor(path = MD, doc = DOC, line = 4): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const base = EditorState.create({ doc });
  const v = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(base.doc.line(line).from),
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
const items = () => screen.queryAllByRole('treeitem');
const labels = () => items().map((i) => i.getAttribute('aria-label'));
const selectedLabel = () => items().find((i) => i.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label');
const currentLabel = () => items().find((i) => i.hasAttribute('data-current'))?.getAttribute('aria-label');
const item = (label: string) => items().find((i) => i.getAttribute('aria-label') === label)!;
const frame = () => act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));

function moveCursor(v: EditorView, line: number): Promise<void> {
  v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(line).from) });
  document.dispatchEvent(new Event('selectionchange'));
  return frame();
}

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
    mode: 'source',
  });
  __resetOutlineStoreForTest();
  useOutlineStore.setState({ expanded: true });
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

describe('分区与空状态', () => {
  it('标题栏切换展开(aria-expanded);默认折叠时不渲染内容', () => {
    useOutlineStore.setState({ expanded: false });
    render(<OutlineSection />);
    const header = screen.getByRole('button', { name: '大纲' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(useOutlineStore.getState().expanded).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('活动编辑器无法提供大纲信息。');
  });

  it('非 Markdown → 无法提供大纲信息;没有标题 → 在文档「x」中找不到符号', async () => {
    mountEditor('/w/a.ts', 'const a = 1;\n', 1);
    render(<OutlineSection />);
    expect(screen.getByRole('status').textContent).toBe('活动编辑器无法提供大纲信息。');
    cleanup();
    mountEditor('/w/plain.md', 'just text\n', 1);
    render(<OutlineSection />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('在文档「plain.md」中找不到符号'));
  });
});

describe('树', () => {
  it('读屏语义:tree「大纲」、treeitem 的 aria-level / aria-expanded / posinset / setsize / 名称;显示 `##` 名称', async () => {
    mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    expect(screen.getByRole('tree').getAttribute('aria-label')).toBe('大纲');
    expect(labels()).toEqual(['Intro', 'Setup', 'Gamma rays', 'Usage']);
    expect(items().map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '2', '1']);
    expect(items().map((i) => i.getAttribute('aria-expanded'))).toEqual(['true', null, null, null]);
    expect(items().map((i) => `${i.getAttribute('aria-posinset')}/${i.getAttribute('aria-setsize')}`)).toEqual(['1/2', '1/2', '2/2', '2/2']);
    expect(item('Gamma rays').textContent).toBe('## Gamma rays');
  });

  it('跟随光标:当前节加粗且为活动行;光标移动后跟随;关掉「跟随光标」后活动行不动、当前节仍标出', async () => {
    const v = mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(selectedLabel()).toBe('Setup'));
    expect(currentLabel()).toBe('Setup');
    await moveCursor(v, 28);
    await waitFor(() => expect(selectedLabel()).toBe('Usage'));
    // 「⋯」菜单:跟随光标是 menuitemcheckbox
    fireEvent.click(screen.getByRole('button', { name: '更多操作…' }));
    const follow = screen.getByRole('menuitemcheckbox', { name: '跟随光标' });
    expect(follow.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(follow);
    expect(useOutlineStore.getState().followCursor).toBe(false);
    await moveCursor(v, 6);
    await waitFor(() => expect(currentLabel()).toBe('Gamma rays'));
    expect(selectedLabel()).toBe('Usage');
  });

  it('折叠的节:当前节落在可见祖先', async () => {
    const v = mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    fireEvent.click(item('Intro').querySelector('span')!); // 箭头
    expect(labels()).toEqual(['Intro', 'Usage']);
    await moveCursor(v, 6);
    await waitFor(() => expect(selectedLabel()).toBe('Intro'));
  });

  it('单击 → 编辑器定位到该标题、焦点留在大纲;记导航', async () => {
    const v = mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    fireEvent.click(item('Usage'), { detail: 1 });
    await waitFor(() => expect(cursorLine(v)).toBe(27));
    expect(v.hasFocus).toBe(false);
    expect(navigationStack().entries.map((e) => e.selection?.line)).toEqual([4, 27]);
  });

  it('键盘:↓ 移动活动行(aria-activedescendant);← 折叠 / → 展开;Enter 定位并聚焦编辑器;空格定位不移焦点', async () => {
    const v = mountEditor(MD, DOC, 1);
    render(<OutlineSection />);
    await waitFor(() => expect(selectedLabel()).toBe('Intro'));
    const tree = screen.getByRole('tree');
    tree.focus();
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(selectedLabel()).toBe('Setup');
    expect(tree.getAttribute('aria-activedescendant')).toBe(item('Setup').id);
    fireEvent.keyDown(tree, { key: ' ' });
    await waitFor(() => expect(cursorLine(v)).toBe(3));
    expect(v.hasFocus).toBe(false);
    await waitFor(() => expect(currentLabel()).toBe('Setup')); // 跟随光标随定位落到该节
    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // 叶子 → 上级
    expect(selectedLabel()).toBe('Intro');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // 折叠
    expect(labels()).toEqual(['Intro', 'Usage']);
    fireEvent.keyDown(tree, { key: 'ArrowRight' }); // 展开
    expect(labels()).toHaveLength(4);
    fireEvent.keyDown(tree, { key: 'End' });
    fireEvent.keyDown(tree, { key: 'Enter' });
    await waitFor(() => expect(cursorLine(v)).toBe(27));
    expect(v.hasFocus).toBe(true);
  });

  it('过滤:只留命中项及其上级;无匹配 → 没有匹配的符号;过滤框 Esc 清空', async () => {
    mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    const box = screen.getByRole('textbox', { name: '筛选' });
    fireEvent.change(box, { target: { value: 'gam' } });
    expect(labels()).toEqual(['Intro', 'Gamma rays']);
    expect(within(item('Gamma rays')).getByText('Gam').tagName).toBe('MARK');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByRole('status').textContent).toBe('没有匹配的符号');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(labels()).toHaveLength(4);
  });

  it('排序依据(menuitemradio):按名称 → 同级按标题文字排', async () => {
    mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    fireEvent.click(screen.getByRole('button', { name: '更多操作…' }));
    expect(screen.getByRole('menuitemradio', { name: '排序依据：位置' }).getAttribute('aria-checked')).toBe('true');
    // 方向键在可勾选项间漫游(use-menu-keyboard 认 menuitemcheckbox / menuitemradio)
    await frame();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemcheckbox');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('排序依据：位置');
    fireEvent.click(screen.getByRole('menuitemradio', { name: '排序依据：名称' }));
    expect(labels()).toEqual(['Intro', 'Gamma rays', 'Setup', 'Usage']);
  });

  it('全部折叠', async () => {
    mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    fireEvent.click(screen.getByRole('button', { name: '全部折叠' }));
    expect(labels()).toEqual(['Intro', 'Usage']);
  });

  it('「聚焦到大纲视图」→ 焦点进树', async () => {
    mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    act(() => focusOutlineView());
    expect(document.activeElement).toBe(screen.getByRole('tree'));
  });

  it('编辑后防抖重解析;换 tab 跟随活动编辑器', async () => {
    mountEditor();
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    act(() => useEditorStore.getState().updateContent(MD, `${DOC}\n## Added`));
    expect(items()).toHaveLength(4); // 防抖期间沿用上次结果
    await waitFor(() => expect(labels()).toContain('Added'));
    mountEditor('/w/other.md', '# Other\n', 1);
    await waitFor(() => expect(labels()).toEqual(['Other']));
  });
});

describe('编辑 / 预览模式(Milkdown 视图句柄)', () => {
  it('当前节按视图句柄;单击按标题序号定位(不聚焦)', async () => {
    useEditorStore.setState({ mode: 'preview' });
    useEditorStore.getState().openTab(createTab(MD, DOC));
    const handle: MarkdownOutlineHandle = {
      currentHeading: vi.fn(() => 2),
      revealHeading: vi.fn(() => true),
      snapshot: vi.fn(() => () => {}),
    };
    render(<OutlineSection />);
    await waitFor(() => expect(items()).toHaveLength(4));
    act(() => {
      registerMarkdownOutline(MD, 'editor', handle);
    });
    await frame();
    await waitFor(() => expect(currentLabel()).toBe('Gamma rays'));
    fireEvent.click(item('Usage'), { detail: 1 });
    await waitFor(() => expect(handle.revealHeading).toHaveBeenCalledWith(3, { focus: false }));
  });
});
