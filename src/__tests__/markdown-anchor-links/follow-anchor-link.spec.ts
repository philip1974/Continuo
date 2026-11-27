// @vitest-environment jsdom
// 点 Markdown 链接的 `#片段`:同文档 / 跨文件定位到标题或行号,源码模式移动光标、编辑 / 预览模式经 markdown-reveal-registry 定位;
// 找不到对应标题时只打开不报错;后退(⌃-)回到跳转前的位置。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('../../panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));
// 引擎 chunk 预热与本规范无关(视图由下方 mountView 模拟挂载)
vi.mock('../../panels/Editor/editor-engine-loaders', async (orig) => ({
  ...(await orig<object>()),
  preloadCodeEditorEngine: () => Promise.resolve(),
}));

import { createTab, groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import {
  installNavigationHistory,
  navigateBack,
  navigationStack,
  resetNavigationHistory,
} from '@/panels/Editor/navigation-history';
import { navigationHistoryExtension } from '@/panels/Editor/codemirror-navigation-history';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { editorFileDeps } from '@/panels/Editor/editor-file-deps';
import { resolveLink } from '@/panels/Editor/link-resolve';
import { followMarkdownLink } from '@/panels/Editor/markdown-link-follow';
import {
  __resetMarkdownRevealForTest,
  registerMarkdownReveal,
  type MarkdownRevealTarget,
} from '@/panels/Editor/markdown-reveal-registry';

const DOC_PATH = '/w/doc.md';
const OTHER_PATH = '/w/sub/other.md';
// doc.md:第 1 行目录链接,之后 60 节,每节 3 行:`## Section N` 在第 3N + 1 行(Section 50 → 151 行)
const DOC = [
  '[Section 50](#section-50) [中文](#安装-指南) [dup](#faq-1) [other](./sub/other.md#section-b) [missing](#nope)',
  ...Array.from({ length: 60 }, (_, i) => ['', `## Section ${i + 1}`, `text ${i + 1}`]).flat(),
  '',
  '## 安装 指南',
  '',
  '## FAQ',
  '',
  '## FAQ',
  '',
].join('\n');
const lineOf = (doc: string, text: string) => doc.split('\n').indexOf(text) + 1;
const OTHER = ['# Other', ...Array.from({ length: 80 }, (_, i) => `filler ${i + 1}`), '## Section B', 'b body', ''].join('\n');

const st = () => useEditorStore.getState();
const active = (): string | null => groupActiveTabIdOf(st(), st().activeGroupId);
const entries = (): string[] =>
  navigationStack().entries.map((e) => `${e.path.slice(3)}${e.selection ? `@${e.selection.line}` : ''}`);
const cursorLine = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number;

const views = new Map<string, EditorView>();
/** 源码模式视图(CodeEditor 的替身)。 */
function mountView(tab: string, doc: string, line = 1): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const base = EditorState.create({ doc });
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(base.doc.line(line).from),
    extensions: navigationHistoryExtension(tab, 'editor'),
  });
  const view = new EditorView({ state, parent });
  st().registerView(tab, view, 'editor');
  views.set(tab, view);
  return view;
}
function unmountAll(): void {
  for (const [tab, view] of views) {
    st().unregisterView(tab, view);
    view.dom.remove();
    view.destroy();
  }
  views.clear();
}
/** 编辑器面板的替身:活动 tab 变了 → 挂载其源码视图。 */
function autoMount(): () => void {
  return useEditorStore.subscribe((s, prev) => {
    const id = s.activeTabId;
    if (id === prev.activeTabId || !id || views.has(id)) return;
    const tab = s.tabs.find((t) => t.id === id);
    queueMicrotask(() => {
      if (tab && !views.has(id)) mountView(id, tab.content);
    });
  });
}

/** EditorPanel handleLinkClick 的同一路由:resolveLink → followMarkdownLink(打开失败由 open 提示)。 */
async function click(href: string): Promise<boolean> {
  const current = active();
  const target = resolveLink(href, current);
  if (target?.kind !== 'file') throw new Error(`not a file link: ${href}`);
  return followMarkdownLink(target.absPath, target.fragment, current, async () => {
    const r = await openFileByPath(target.absPath, editorFileDeps);
    return r.ok;
  });
}

let uninstall: () => void = () => {};
let stopAutoMount: () => void = () => {};
beforeAll(() => {
  uninstall = installNavigationHistory();
});
afterAll(() => uninstall());

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  mocks.readFile.mockReset();
  mocks.readFile.mockImplementation(async (p: string) =>
    p === OTHER_PATH ? { ok: true, data: OTHER } : { ok: false, code: 'FS_NOT_FOUND', message: 'nope' },
  );
  useWorkspaceStore.setState({ root: null });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
    mode: 'source',
  });
  resetNavigationHistory();
  __resetMarkdownRevealForTest();
  st().openTab(createTab(DOC_PATH, DOC));
});

afterEach(async () => {
  stopAutoMount();
  await Promise.resolve();
  unmountAll();
});

describe('源码模式(CodeMirror):光标移到标题行,后退回到原处', () => {
  beforeEach(() => {
    // 光标停在第 1 行(目录链接所在行)
    mountView(DOC_PATH, DOC, 1);
    stopAutoMount = autoMount();
  });

  it('同文档 #section-50 → 光标到 `## Section 50` 行;⌃- 回到第 1 行', async () => {
    expect(await click('#section-50')).toBe(true);
    const view = views.get(DOC_PATH)!;
    expect(cursorLine(view)).toBe(lineOf(DOC, '## Section 50'));
    expect(entries()).toEqual(['doc.md@1', `doc.md@${lineOf(DOC, '## Section 50')}`]);
    await navigateBack();
    expect(cursorLine(view)).toBe(1);
  });

  it('中文标题(片段 percent-encoded 亦可)、重复标题的第二个(-1)、片段不区分大小写', async () => {
    const view = views.get(DOC_PATH)!;
    expect(await click('#%E5%AE%89%E8%A3%85-%E6%8C%87%E5%8D%97')).toBe(true);
    expect(cursorLine(view)).toBe(lineOf(DOC, '## 安装 指南'));
    expect(await click('#FAQ-1')).toBe(true);
    expect(cursorLine(view)).toBe(DOC.split('\n').lastIndexOf('## FAQ') + 1);
    expect(await click('#faq')).toBe(true);
    expect(cursorLine(view)).toBe(lineOf(DOC, '## FAQ'));
  });

  it('行号片段 #L10 / #L12,3', async () => {
    const view = views.get(DOC_PATH)!;
    expect(await click('#L10')).toBe(true);
    expect(cursorLine(view)).toBe(10);
    expect(await click('#L12,3')).toBe(true);
    expect(view.state.selection.main.head - view.state.doc.line(12).from).toBe(2);
  });

  it('找不到对应标题:不动、不报错、不记导航', async () => {
    const view = views.get(DOC_PATH)!;
    expect(await click('#nope')).toBe(false);
    expect(cursorLine(view)).toBe(1);
    expect(entries()).toEqual(['doc.md']);
  });

  it('跨文件 ./sub/other.md#section-b → 打开后光标在 `## Section B`;⌃- 回到 doc.md 第 1 行', async () => {
    expect(await click('./sub/other.md#section-b')).toBe(true);
    expect(active()).toBe(OTHER_PATH);
    expect(cursorLine(views.get(OTHER_PATH)!)).toBe(lineOf(OTHER, '## Section B'));
    expect(entries()).toEqual(['doc.md@1', `sub/other.md@${lineOf(OTHER, '## Section B')}`]);
    await navigateBack();
    expect(active()).toBe(DOC_PATH);
    expect(cursorLine(views.get(DOC_PATH)!)).toBe(1);
  });

  it('跨文件但片段对不上:照常打开(停在开头),不报错', async () => {
    expect(await click('./sub/other.md#nope')).toBe(false);
    expect(active()).toBe(OTHER_PATH);
    await Promise.resolve();
    expect(cursorLine(views.get(OTHER_PATH)!)).toBe(1);
  });
});

describe('编辑 / 预览模式(Milkdown):经 markdown-reveal-registry 按源码行定位', () => {
  it.each(['edit', 'preview'] as const)('%s:同文档锚点定位到标题行,记跳转前所在行;⌃- 定位回原行', async (mode) => {
    st().setMode(mode);
    let at = 1; // 视图当前所在源码行(编辑:光标行;预览:顶部可见行)
    const reveal = vi.fn((target: MarkdownRevealTarget) => {
      at = target.line;
      return 'applied' as const;
    });
    registerMarkdownReveal(DOC_PATH, reveal, 'editor', () => at);
    const heading = lineOf(DOC, '## Section 50');
    expect(await click('#section-50')).toBe(true);
    expect(reveal).toHaveBeenLastCalledWith({ line: heading });
    expect(entries()).toEqual(['doc.md@1', `doc.md@${heading}`]);
    await navigateBack();
    expect(reveal).toHaveBeenLastCalledWith({ line: 1 });
  });
});
