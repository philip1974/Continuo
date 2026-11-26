// @vitest-environment jsdom
// BDD: editor-navigation-history 第 2 条「打开到第 N 行」—— 搜索结果 / 终端链接 / 调试栈帧等经 editor.openFile({line}) 打开到某行、
// ⇧⌘T 重新打开、后退到未打开的文件:只记一条(目标位置),后退一次即回到来处;不多停一个第 1 行(第四十轮审计)。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('../../panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));
// 引擎 chunk 预热与本规范无关(jsdom 里不渲染编辑器面板,视图由下方 mountView 模拟挂载)
vi.mock('../../panels/Editor/editor-engine-loaders', async (orig) => ({
  ...(await orig<object>()),
  preloadCodeEditorEngine: () => Promise.resolve(),
}));

import { coApp } from '@/plugins/co-app';
import { createTab, groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import {
  installNavigationHistory,
  navigateBack,
  navigateForward,
  navigationStack,
  resetNavigationHistory,
} from '@/panels/Editor/navigation-history';
import { navigationHistoryExtension } from '@/panels/Editor/codemirror-navigation-history';
import { scrollToLine } from '@/panels/Editor/scrollToLine';
import { openSearchMatch } from '@/panels/Search/search-store';
import { reopenClosedEditor } from '@/panels/Editor/reopen-closed-editor';

const [A, B] = ['/w/a.ts', '/w/long.ts'] as const;
const DOC = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
const st = () => useEditorStore.getState();
const entries = (): string[] =>
  navigationStack().entries.map((e) => `${e.path}${e.selection ? `@${e.selection.line}` : ''}`);
const active = (): string | null => groupActiveTabIdOf(st(), st().activeGroupId);
const cursorLine = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number;

const views = new Map<string, EditorView>();
/** 挂载 tab 的视图(编辑器面板挂载 CodeEditor 的替身:新视图光标在第 line 行,或视图状态恢复的位置)。 */
function mountView(tab: string, line = 1): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc: DOC,
    selection: EditorSelection.cursor(EditorState.create({ doc: DOC }).doc.line(line).from),
    extensions: navigationHistoryExtension(tab, 'editor'),
  });
  const view = new EditorView({ state, parent });
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
/** 编辑器面板的替身:活动 tab 变了 → 卸载旧视图、挂载新视图(光标在第 1 行)。 */
function autoMountActiveTab(): () => void {
  return useEditorStore.subscribe((s, prev) => {
    if (s.activeTabId === prev.activeTabId) return;
    if (prev.activeTabId) unmountView(prev.activeTabId);
    const id = s.activeTabId;
    if (id && !views.has(id)) queueMicrotask(() => mountView(id));
  });
}
const userMoveTo = (view: EditorView, line: number) =>
  view.dispatch({ selection: { anchor: view.state.doc.line(line).from }, userEvent: 'select.pointer' });

let uninstall: () => void = () => {};
let stopAutoMount: () => void = () => {};
beforeAll(() => {
  uninstall = installNavigationHistory();
});
afterAll(() => uninstall());

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  mocks.readFile.mockReset();
  mocks.readFile.mockResolvedValue({ ok: true, data: DOC });
  useWorkspaceStore.setState({ root: null });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
  resetNavigationHistory();
  // 来处:file-2.ts(这里是 a.ts)第 5 行
  st().openTab(createTab(A, DOC));
  userMoveTo(mountView(A), 5);
  stopAutoMount = autoMountActiveTab();
});

afterEach(async () => {
  stopAutoMount();
  await Promise.resolve(); // 已排队的挂载先落定,再统一卸载(不漏到下一条)
  for (const tab of [...views.keys()]) unmountView(tab);
});

async function expectOneBackReturnsToA(): Promise<void> {
  await navigateBack();
  expect(active()).toBe(A);
  expect(cursorLine(views.get(A) ?? mountView(A))).toBe(5);
}

describe('打开到第 N 行:只记目标,后退一次回到来处', () => {
  it('editor.openFile({line})(终端链接 / 调试栈帧同一入口):视图刚挂载即定位 → 不补记第 1 行', async () => {
    const r = await coApp.editor.openFile(B, { line: 321 });
    expect(r).toMatchObject({ ok: true, lineApplied: true });
    expect(entries()).toEqual([`${A}@5`, `${B}@321`]);
    await expectOneBackReturnsToA();
  });

  it('在文件中查找的结果(openSearchMatch)', async () => {
    await openSearchMatch({ path: B, relPath: 'long.ts', matches: [{ line: 321, column: 1, length: 3, preview: 'x' }] } as never, 0);
    expect(cursorLine(views.get(B)!)).toBe(321);
    expect(entries()).toEqual([`${A}@5`, `${B}@321`]);
    await expectOneBackReturnsToA();
  });

  it('程序化定位(scrollToLine,无 userEvent)替换只记文件的当前这条', async () => {
    st().openTab(createTab(B, DOC));
    await Promise.resolve(); // 视图挂载
    scrollToLine(views.get(B)!, 321, undefined, undefined, { focus: false });
    expect(entries()).toEqual([`${A}@5`, `${B}@321`]);
  });

  it('对照:用户在刚打开的文件里点击跳远 → 仍先补记停留过的第 1 行', async () => {
    st().openTab(createTab(B, DOC));
    await Promise.resolve();
    userMoveTo(views.get(B)!, 300);
    expect(entries()).toEqual([`${A}@5`, `${B}@1`, `${B}@300`]);
  });
});

describe('⇧⌘T 重新打开 / 后退到未打开的文件', () => {
  it('⇧⌘T:重新打开的文件只记一条,后退一次回到来处', async () => {
    await coApp.editor.openFile(B, { line: 200 });
    st().closeTab(B);
    await Promise.resolve();
    userMoveTo(views.get(A)!, 5);
    const before = entries().length;
    await reopenClosedEditor();
    await Promise.resolve();
    expect(active()).toBe(B);
    expect(entries().length).toBe(before + 1);
    await expectOneBackReturnsToA();
  });

  it('后退到已关闭(未打开)的文件:读盘打开并定位,不多出记录;再前进回到原处', async () => {
    const r = await coApp.editor.openFile(B, { line: 321 });
    expect(r.ok).toBe(true);
    st().closeTab(A); // 来处已关闭
    await Promise.resolve();
    expect(entries()).toEqual([`${A}@5`, `${B}@321`]);
    await navigateBack();
    expect(active()).toBe(A);
    expect(cursorLine(views.get(A)!)).toBe(5);
    expect(entries()).toEqual([`${A}@5`, `${B}@321`]);
    await navigateForward();
    expect(active()).toBe(B);
    expect(cursorLine(views.get(B)!)).toBe(321);
  });
});
