// @vitest-environment jsdom
// 编辑器状态跨重启 / 切 tab 保持(VSCode:编辑器视图状态与图片预览缩放随会话恢复)。见同目录 README.md。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
const mocks = vi.hoisted(() => ({ readImage: vi.fn() }));
vi.mock('../../lib/co-api', () => ({ coApi: { fs: { readImage: mocks.readImage } } }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { ImageViewer } from '../../panels/Editor/ImageViewer';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  clearEditorViewStates,
  markdownScrollTopOf,
  saveMarkdownScrollTop,
} from '../../panels/Editor/editor-view-state-cache';
import {
  hydrateEditorTabs,
  hydrateStores,
  initExplorerPersistence,
  snapshotFromStores,
  flushExplorerPersistence,
  type EditorSessionFsApi,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';
import {
  EDITOR_VIEW_STATES_MAX,
  ExplorerSchemaV3,
  ExplorerWritableSnapshotSchema,
} from '../../../electron/shared/explorer-persistence-schema';

const TEXT = 'l1\nl2\nl3\nl4\nl5\n';
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

type EditorSession = NonNullable<ExplorerSnapshot['windows'][number]['editor']>;

function snapWith(editor: EditorSession, root: string | null = null): ExplorerSnapshot {
  return {
    version: 3,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [
      {
        windowSeq: 0,
        workspace: { root },
        explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
        editor,
      },
    ],
  };
}

function fsOf(files: Record<string, string>): EditorSessionFsApi {
  return {
    readFile: vi.fn(async (p: string) =>
      files[p] === undefined
        ? { ok: false as const, code: 'FS_ENOENT', message: 'nf' }
        : { ok: true as const, data: files[p]! },
    ),
  };
}

function mountCode(tabId: string, value: string) {
  const r = render(<CodeEditor key={tabId} tabId={tabId} value={value} fileName={tabId} onChange={() => {}} />);
  const view = useEditorStore.getState().viewRefs.get(tabId) as EditorView;
  return { ...r, view };
}

/** 渲染并加载一张 640x480 的图(适应时宽 320 = 50%)。 */
async function mountImage(tabId: string) {
  const r = render(<ImageViewer key={tabId} tabId={tabId} filePath={tabId} />);
  await act(async () => {
    await Promise.resolve();
  });
  const viewer = r.container.querySelector<HTMLElement>('[data-image-viewer]')!;
  const img = viewer.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: 640 });
  Object.defineProperty(img, 'naturalHeight', { value: 480 });
  Object.defineProperty(img, 'clientWidth', { configurable: true, value: 320 });
  fireEvent.load(img);
  return { ...r, viewer, img };
}

const zoomLabel = () => screen.getByText(/640x480/).textContent ?? '';

beforeEach(() => {
  // jsdom 无布局:CodeMirror 的 scrollIntoView 量 Range 矩形
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  clearEditorViewStates();
  mocks.readImage.mockResolvedValue({ ok: true, data: { dataUrl: DATA_URL, size: 2048 } });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'source', viewRefs: new Map() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('磁盘契约:editor 段的视图状态与 Markdown 模式(读≡写同一 schema、上限对称)', () => {
  const both = [ExplorerWritableSnapshotSchema, ExplorerSchemaV3] as const;

  it('旧快照(无 viewStates / mode)读写都仍合法', () => {
    const snap = snapWith({ openFilePaths: ['/w/a.ts'], activePath: '/w/a.ts' });
    for (const s of both) expect(s.safeParse(snap).success).toBe(true);
  });

  it('含光标 / 首行 / Markdown 滚动 / 图片缩放的条目与非默认模式合法', () => {
    const snap = snapWith({
      openFilePaths: ['/w/a.ts', '/w/b.md', '/w/c.png'],
      activePath: '/w/a.ts',
      mode: 'preview',
      viewStates: [
        { path: '/w/a.ts', selection: { anchor: 3, head: 5 }, topLine: 2 },
        { path: '/w/b.md', scrollTop: 120.5 },
        { path: '/w/c.png', image: { scale: 2, scrollLeft: 10, scrollTop: 20 } },
        { path: '/w/d.png', image: { scale: 'fit', scrollLeft: 0, scrollTop: 0 } },
      ],
    });
    for (const s of both) expect(s.safeParse(snap).success).toBe(true);
  });

  it.each([
    ['负偏移', { path: '/w/a', selection: { anchor: -1, head: 0 } }],
    ['非整数偏移', { path: '/w/a', selection: { anchor: 1.5, head: 0 } }],
    ['首行 0', { path: '/w/a', topLine: 0 }],
    ['负滚动', { path: '/w/a', scrollTop: -1 }],
    ['缩放越界', { path: '/w/a', image: { scale: 100, scrollLeft: 0, scrollTop: 0 } }],
    ['未知字段', { path: '/w/a', cursor: 1 }],
  ])('畸形条目(%s)读写都拒', (_name, entry) => {
    const snap = snapWith({ openFilePaths: [], activePath: null, viewStates: [entry as never] });
    for (const s of both) expect(s.safeParse(snap).success).toBe(false);
  });

  it(`viewStates 超过 ${EDITOR_VIEW_STATES_MAX} 条读写都拒`, () => {
    const many = Array.from({ length: EDITOR_VIEW_STATES_MAX + 1 }, (_, i) => ({ path: `/w/${i}`, topLine: 1 }));
    const ok = snapWith({ openFilePaths: [], activePath: null, viewStates: many.slice(0, -1) });
    const over = snapWith({ openFilePaths: [], activePath: null, viewStates: many });
    for (const s of both) {
      expect(s.safeParse(ok).success).toBe(true);
      expect(s.safeParse(over).success).toBe(false);
    }
  });
});

describe('写快照:打开中的 tab 的视图状态 + 非默认模式', () => {
  it('CodeMirror 活动视图 → 记选区与顶部可见行;已卸载 tab 取缓存;Markdown 滚动取缓存', () => {
    useEditorStore.setState({
      tabs: [createTab('/w/a.ts', TEXT), createTab('/w/b.ts', TEXT), createTab('/w/c.md', '# c')],
      activeTabId: '/w/a.ts',
    });
    const b = mountCode('/w/b.ts', TEXT);
    b.view.dispatch({ selection: { anchor: 4 } });
    b.unmount();
    const a = mountCode('/w/a.ts', TEXT);
    a.view.dispatch({ selection: { anchor: 1, head: 7 } });
    saveMarkdownScrollTop('/w/c.md', 333);

    const ed = snapshotFromStores().windows[0]!.editor!;
    expect(ed.viewStates).toEqual([
      { path: '/w/a.ts', selection: { anchor: 1, head: 7 }, topLine: 1 },
      { path: '/w/b.ts', selection: { anchor: 4, head: 4 }, topLine: 1 },
      { path: '/w/c.md', scrollTop: 333 },
    ]);
    expect(ExplorerWritableSnapshotSchema.safeParse(snapshotFromStores()).success).toBe(true);
  });

  it('滚动后 → topLine 记的是顶部可见行(按滚动位置,而非光标行)', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join('\n');
    useEditorStore.setState({ tabs: [createTab('/w/long.ts', long)], activeTabId: '/w/long.ts' });
    const { view } = mountCode('/w/long.ts', long);
    const lineHeight = view.defaultLineHeight;
    view.scrollDOM.scrollTop = lineHeight * 50;
    const entry = snapshotFromStores().windows[0]!.editor!.viewStates![0]!;
    expect(entry.selection).toEqual({ anchor: 0, head: 0 });
    expect(entry.topLine).toBeGreaterThan(40);
  });

  it('无任何视图状态 / 模式为默认 source → 不写这两个字段(旧形态不变)', () => {
    useEditorStore.setState({ tabs: [createTab('/w/a.ts', TEXT)], activeTabId: '/w/a.ts' });
    expect(snapshotFromStores().windows[0]!.editor).toEqual({ openFilePaths: ['/w/a.ts'], activePath: '/w/a.ts' });
  });

  it('模式切到 edit / preview → 写 mode', () => {
    useEditorStore.setState({ mode: 'preview' });
    expect(snapshotFromStores().windows[0]!.editor!.mode).toBe('preview');
  });

  it('插件打开的 tab 不写视图状态(与 openFilePaths 同口径)', () => {
    useEditorStore.setState({
      tabs: [{ ...createTab('/w/p.md', '# p'), pluginOpenedPath: '/w/p.md' }],
      activeTabId: '/w/p.md',
    });
    saveMarkdownScrollTop('/w/p.md', 50);
    expect(snapshotFromStores().windows[0]!.editor!.viewStates).toBeUndefined();
  });

  it(`条目数守写入上限(${EDITOR_VIEW_STATES_MAX}),写出的快照仍过 schema`, async () => {
    // 上次会话恢复出的状态(seed)可覆盖每个恢复的 tab,不受内存缓存 50 条 LRU 约束;再叠加本次会话的 Markdown 滚动
    const paths = Array.from({ length: EDITOR_VIEW_STATES_MAX }, (_, i) => `/w/${i}.ts`);
    const snap = snapWith({
      openFilePaths: paths,
      activePath: null,
      viewStates: paths.map((p) => ({ path: p, selection: { anchor: 0, head: 0 }, topLine: 1 })),
    });
    await hydrateEditorTabs(snap, fsOf(Object.fromEntries(paths.map((p) => [p, 'x']))));
    for (let i = 0; i < 10; i++) {
      useEditorStore.getState().openTab(createTab(`/w/extra${i}.md`, '#'));
      saveMarkdownScrollTop(`/w/extra${i}.md`, 5);
    }
    const out = snapshotFromStores();
    expect(out.windows[0]!.editor!.viewStates!.length).toBe(EDITOR_VIEW_STATES_MAX);
    expect(ExplorerWritableSnapshotSchema.safeParse(out).success).toBe(true);
  });
});

describe('恢复:tab 恢复后按快照定位', () => {
  it('CodeMirror:首次挂载用快照的选区,并把快照的首行滚到视口顶', async () => {
    const spy = vi.spyOn(EditorView, 'scrollIntoView');
    await hydrateEditorTabs(
      snapWith({
        openFilePaths: ['/w/a.ts'],
        activePath: '/w/a.ts',
        viewStates: [{ path: '/w/a.ts', selection: { anchor: 6, head: 8 }, topLine: 4 }],
      }),
      fsOf({ '/w/a.ts': TEXT }),
    );
    const { view } = mountCode('/w/a.ts', TEXT);
    expect(view.state.selection.main.anchor).toBe(6);
    expect(view.state.selection.main.head).toBe(8);
    expect(spy).toHaveBeenCalledWith(view.state.doc.line(4).from, { y: 'start' });
  });

  it('文件在外部变短 → 选区与首行收进新文档范围(不越界抛错)', async () => {
    const spy = vi.spyOn(EditorView, 'scrollIntoView');
    await hydrateEditorTabs(
      snapWith({
        openFilePaths: ['/w/a.ts'],
        activePath: '/w/a.ts',
        viewStates: [{ path: '/w/a.ts', selection: { anchor: 900, head: 1000 }, topLine: 400 }],
      }),
      fsOf({ '/w/a.ts': 'ab' }),
    );
    const { view } = mountCode('/w/a.ts', 'ab');
    expect(view.state.selection.main.anchor).toBe(2);
    expect(view.state.selection.main.head).toBe(2);
    expect(spy).toHaveBeenCalledWith(0, { y: 'start' });
  });

  it('快照状态只用于首次挂载:之后切走再切回按本次会话的状态', async () => {
    await hydrateEditorTabs(
      snapWith({
        openFilePaths: ['/w/a.ts'],
        activePath: '/w/a.ts',
        viewStates: [{ path: '/w/a.ts', selection: { anchor: 6, head: 6 }, topLine: 1 }],
      }),
      fsOf({ '/w/a.ts': TEXT }),
    );
    const first = mountCode('/w/a.ts', TEXT);
    first.view.dispatch({ selection: { anchor: 2 } });
    first.unmount();
    const second = mountCode('/w/a.ts', TEXT);
    expect(second.view.state.selection.main.head).toBe(2);
  });

  it('Markdown(Milkdown)滚动位置恢复为快照值', async () => {
    await hydrateEditorTabs(
      snapWith({ openFilePaths: ['/w/b.md'], activePath: '/w/b.md', viewStates: [{ path: '/w/b.md', scrollTop: 640 }] }),
      fsOf({ '/w/b.md': '# b' }),
    );
    expect(markdownScrollTopOf('/w/b.md')).toBe(640);
  });

  it('快照里有、但读盘失败未恢复的 tab 不留下视图状态', async () => {
    await hydrateEditorTabs(
      snapWith({ openFilePaths: ['/w/gone.md'], activePath: null, viewStates: [{ path: '/w/gone.md', scrollTop: 9 }] }),
      fsOf({}),
    );
    expect(markdownScrollTopOf('/w/gone.md')).toBeUndefined();
  });

  it('Markdown 模式随窗口段恢复(hydrateStores)', () => {
    hydrateStores(snapWith({ openFilePaths: [], activePath: null, mode: 'preview' }));
    expect(useEditorStore.getState().mode).toBe('preview');
  });

  it('未切换过模式的旧快照 → 模式保持默认 source', () => {
    hydrateStores(snapWith({ openFilePaths: [], activePath: null }));
    expect(useEditorStore.getState().mode).toBe('source');
  });
});

describe('落盘时机', () => {
  afterEach(() => vi.useRealTimers());

  it('切换 Markdown 模式 → 调度持久化写', async () => {
    const api: ExplorerPersistApi = {
      read: vi.fn(async () => ({ ok: true as const, data: null })),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };
    await initExplorerPersistence(api);
    vi.useFakeTimers();
    useEditorStore.getState().setMode('edit');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.write).toHaveBeenCalledTimes(1);
    const snap = (api.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExplorerSnapshot;
    expect(snap.windows[0]!.editor!.mode).toBe('edit');
  });

  it('关窗 / 退出的立即落盘带上最新光标(光标移动本身不调度写)', async () => {
    useEditorStore.setState({ tabs: [createTab('/w/a.ts', TEXT)], activeTabId: '/w/a.ts' });
    const api: ExplorerPersistApi = {
      read: vi.fn(async () => ({ ok: true as const, data: null })),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };
    await initExplorerPersistence(api);
    const { view } = mountCode('/w/a.ts', TEXT);
    await flushExplorerPersistence();
    view.dispatch({ selection: { anchor: 9 } });
    await flushExplorerPersistence();
    const calls = (api.write as ReturnType<typeof vi.fn>).mock.calls;
    const last = calls[calls.length - 1]![0] as ExplorerSnapshot;
    expect(last.windows[0]!.editor!.viewStates).toEqual([
      { path: '/w/a.ts', selection: { anchor: 9, head: 9 }, topLine: 1 },
    ]);
  });
});

describe('图片预览:缩放比例与滚动位置按 tab 保留', () => {
  beforeEach(() => {
    useEditorStore.setState({
      tabs: [createTab('/w/a.png', ''), createTab('/w/b.png', '')],
      activeTabId: '/w/a.png',
    });
  });

  it('放大并滚动后切走再切回 → 比例与滚动位置保留', async () => {
    const first = await mountImage('/w/a.png');
    fireEvent.click(first.img, { button: 0 }); // 50% → 60%
    expect(zoomLabel()).toContain('60%');
    first.viewer.scrollLeft = 40;
    first.viewer.scrollTop = 70;
    fireEvent.scroll(first.viewer);
    first.unmount();

    const second = await mountImage('/w/a.png');
    expect(zoomLabel()).toContain('60%');
    expect(second.img.style.width).toBe('384px');
    expect(second.viewer.scrollLeft).toBe(40);
    expect(second.viewer.scrollTop).toBe(70);
  });

  it('各图片 tab 互不影响', async () => {
    const a = await mountImage('/w/a.png');
    fireEvent.click(a.img, { button: 0 });
    a.unmount();
    await mountImage('/w/b.png');
    expect(zoomLabel()).not.toContain('60%');
  });

  it('缩放状态写进快照,重启恢复后首次打开即为该比例', async () => {
    const a = await mountImage('/w/a.png');
    fireEvent.click(a.img, { button: 0 });
    a.unmount();
    const snap = snapshotFromStores();
    const entry = snap.windows[0]!.editor!.viewStates!.find((v) => v.path === '/w/a.png');
    expect(entry?.image?.scale).toBeCloseTo(0.6);

    clearEditorViewStates();
    useEditorStore.setState({ tabs: [], activeTabId: null });
    await hydrateEditorTabs(snap, fsOf({ '/w/a.png': '', '/w/b.png': '' }));
    await mountImage('/w/a.png');
    expect(zoomLabel()).toContain('60%');
  });
});
