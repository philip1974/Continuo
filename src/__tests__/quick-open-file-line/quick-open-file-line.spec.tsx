// @vitest-environment jsdom
// BDD: quick-open-file-line —— ⌘P 输入 `文件名:行号` 匹配文件并打开到该行;导航历史只记一条。见同目录 README。
import React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('../../panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));
vi.mock('../../panels/Editor/editor-engine-loaders', async (orig) => ({
  ...(await orig<object>()),
  preloadCodeEditorEngine: () => Promise.resolve(),
}));
vi.mock('../../plugins/quick-open/walk-files', () => ({ walkWorkspaceFiles: vi.fn() }));
// jsdom 无布局:virtualizer 渲染全部行(同 quick-open-recent)
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { parseFileLineQuery } from '@/plugins/quick-open/goto-line';
import { QuickOpenModal } from '@/plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore, type QuickOpenFile } from '@/plugins/quick-open/store';
import { walkWorkspaceFiles } from '@/plugins/quick-open/walk-files';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { createTab, useEditorStore } from '@/stores/editor.store';
import {
  installNavigationHistory,
  navigateBack,
  navigationStack,
  resetNavigationHistory,
} from '@/panels/Editor/navigation-history';
import { navigationHistoryExtension } from '@/panels/Editor/codemirror-navigation-history';

describe('解析 `文件:行` 查询(VSCode extractRangeFromFilter)', () => {
  it.each([
    ['long.ts:200', 'long.ts', { line: 200 }],
    ['long.ts:200:7', 'long.ts', { line: 200, column: 7 }],
    ['long.ts#200', 'long.ts', { line: 200 }],
    ['long.ts(200)', 'long.ts', { line: 200 }],
    ['long.ts(200,7)', 'long.ts', { line: 200, column: 7 }],
    ['long.ts (200)', 'long.ts', { line: 200 }],
    ['long.ts:line 200', 'long.ts', { line: 200 }],
    ['long.ts:200-210', 'long.ts', { line: 200 }],
    ['src/long.ts:200 ', 'src/long.ts', { line: 200 }],
    ['long.ts:', 'long.ts', { line: 1 }],
    ['long.ts:0', 'long.ts', { line: 1 }],
  ])('%s → 文件 %s,%o', (query, filter, target) => {
    expect(parseFileLineQuery(query)).toEqual({ filter, target });
  });

  it('不带行列 / 转到行模式(`:` 开头)/ 剥掉后为空 → null', () => {
    for (const q of ['long.ts', 'long', ':200', '(5)', '', 'a:b']) expect(parseFileLineQuery(q), q).toBeNull();
  });
});

const A = '/proj/a.ts';
const B = '/proj/src/long.ts';
const DOC = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
const walkMock = walkWorkspaceFiles as unknown as ReturnType<typeof vi.fn>;
const st = () => useEditorStore.getState();

function file(absPath: string): QuickOpenFile {
  const relPath = absPath.slice('/proj/'.length);
  return { name: relPath.split('/').pop()!, relPath, relPathLower: relPath.toLowerCase(), absPath };
}

const views = new Map<string, EditorView>();
/** 编辑器面板的替身:挂载 tab 的视图(光标在第 line 行)。 */
function mountView(tab: string, line = 1): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const doc = EditorState.create({ doc: DOC }).doc;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      selection: EditorSelection.cursor(doc.line(line).from),
      extensions: navigationHistoryExtension(tab, 'editor'),
    }),
  });
  st().registerView(tab, view, 'editor');
  views.set(tab, view);
  return view;
}
function unmountView(tab: string): void {
  const view = views.get(tab);
  if (!view) return;
  views.delete(tab);
  st().unregisterView(tab, view);
  view.dom.remove();
  view.destroy();
}
const cursorLine = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number;
const entries = () => navigationStack().entries.map((e) => `${e.path}${e.selection ? `@${e.selection.line}` : ''}`);

async function quickOpen(query: string): Promise<HTMLInputElement> {
  useQuickOpenStore.setState({ isOpen: true });
  render(<QuickOpenModal />);
  await waitFor(() => expect(document.querySelectorAll('[role=option]').length).toBe(2));
  const input = document.querySelector<HTMLInputElement>('input')!;
  fireEvent.change(input, { target: { value: query } });
  return input;
}
const rowNames = () => Array.from(document.querySelectorAll('[role=option]')).map((r) => r.querySelector('span')!.textContent);

let uninstall: () => void = () => {};
let stopAutoMount: () => void = () => {};
beforeAll(() => {
  uninstall = installNavigationHistory();
});
afterAll(() => uninstall());

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  localStorage.clear();
  mocks.readFile.mockReset();
  mocks.readFile.mockResolvedValue({ ok: true, data: DOC });
  walkMock.mockReset();
  walkMock.mockResolvedValue({ ok: true, data: [file(A), file(B)] });
  useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0, results: [], resultsRoot: null, loading: false, scanFailed: false });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  resetNavigationHistory();
  // 来处:a.ts 第 5 行
  st().openTab(createTab(A, DOC));
  mountView(A).dispatch({ selection: { anchor: views.get(A)!.state.doc.line(5).from }, userEvent: 'select.pointer' });
  // 活动 tab 变了 → 卸载旧视图、挂载新视图
  stopAutoMount = useEditorStore.subscribe((s, prev) => {
    if (s.activeTabId === prev.activeTabId) return;
    if (prev.activeTabId) unmountView(prev.activeTabId);
    const id = s.activeTabId;
    if (id && !views.has(id)) queueMicrotask(() => mountView(id));
  });
});

afterEach(async () => {
  stopAutoMount();
  cleanup();
  await Promise.resolve();
  for (const tab of [...views.keys()]) unmountView(tab);
});

describe('⌘P 输入 `文件:行`', () => {
  it('`long.ts:200` 列出 long.ts(不再「No matching files」);Enter 打开并跳到第 200 行', async () => {
    const input = await quickOpen('long.ts:200');
    expect(rowNames()).toEqual(['long.ts']);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(views.get(B) && cursorLine(views.get(B)!)).toBe(200));
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
  });

  it('`long.ts:200:7` 跳到第 200 行第 7 列;点击行同样生效', async () => {
    await quickOpen('long.ts(200,7)');
    act(() => (document.querySelector('[role=option]') as HTMLElement).click());
    await waitFor(() => expect(views.get(B) && cursorLine(views.get(B)!)).toBe(200));
    const view = views.get(B)!;
    expect(view.state.selection.main.head - view.state.doc.line(200).from).toBe(6);
  });

  it('导航历史只记一条:后退一次回到来处 a.ts 第 5 行', async () => {
    const input = await quickOpen('long.ts:200');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(views.get(B) && cursorLine(views.get(B)!)).toBe(200));
    expect(entries()).toEqual([`${A}@5`, `${B}@200`]);
    await navigateBack();
    expect(st().activeTabId).toBe(A);
    expect(cursorLine(views.get(A)!)).toBe(5);
  });

  it('不带行列:照旧打开文件,不改光标位置', async () => {
    const input = await quickOpen('long');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(views.get(B)).toBeDefined());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(cursorLine(views.get(B)!)).toBe(1);
  });
});
