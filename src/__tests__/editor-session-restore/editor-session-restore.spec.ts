// @vitest-environment jsdom
// BDD: editor-session-restore
// 测三层:snapshotFromStores 含 editor 字段;hydrateEditorTabs async helper;
// initExplorerPersistence 集成(fs 注入路径)。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTab,
  useEditorStore,
} from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useExplorerStore } from '../../stores/explorer.store';
import { usePinnedStore } from '../../stores/pinned.store';
import {
  SIDEBAR_DEFAULT_WIDTH,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
import {
  collectEditorSnapshot,
  hasEditorTabWithId,
  hydrateEditorTabs,
  initExplorerPersistence,
  snapshotFromStores,
  type EditorSessionFsApi,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';

function resetAll(): void {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
  usePinnedStore.setState({ paths: [] });
  useLayoutUiStore.setState({
    sidebarOpen: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
}

beforeEach(resetAll);

function makeFs(
  files: Record<string, string>,
  opts: { fail?: ReadonlySet<string>; reject?: ReadonlySet<string> } = {},
): EditorSessionFsApi {
  return {
    readFile: vi.fn(async (path: string) => {
      if (opts.reject?.has(path)) {
        // 模拟 IPC 桥/进程/通道异常:invoke 的 promise 本身 reject(非 handler 的 {ok:false})
        throw Object.assign(new Error('bridge crash'), { code: 'EPIPE' });
      }
      if (opts.fail?.has(path)) {
        return { ok: false as const, code: 'FS_ENOENT', message: 'not found' };
      }
      const c = files[path];
      if (c === undefined) {
        return { ok: false as const, code: 'FS_ENOENT', message: 'not found' };
      }
      return { ok: true as const, data: c };
    }),
  };
}

// ────────────────────────────────────────────────────────────
// snapshotFromStores · editor 字段
// ────────────────────────────────────────────────────────────

describe('snapshotFromStores · editor 字段', () => {
  it('tabs=[] → openFilePaths=[],activePath=null', () => {
    const snap = snapshotFromStores();
    expect(snap.windows[0]!.editor).toEqual({
      openFilePaths: [],
      activePath: null,
    });
  });

  it('多 file tab + active → 顺序保留 + activePath 指 active 的 filePath', () => {
    useEditorStore.setState({
      tabs: [
        createTab('/a.md', 'a'),
        createTab('/b.md', 'b'),
        createTab('/c.md', 'c'),
      ],
      activeTabId: '/b.md',
    });
    const snap = snapshotFromStores();
    expect(snap.windows[0]!.editor!.openFilePaths).toEqual(['/a.md', '/b.md', '/c.md']);
    expect(snap.windows[0]!.editor!.activePath).toBe('/b.md');
  });

  it('含 untitled tab(filePath=null)→ 不进 openFilePaths', () => {
    const untitled = createTab(null, 'draft');
    const tabs = [createTab('/x.md', 'x'), untitled, createTab('/y.md', 'y')];
    useEditorStore.setState({ tabs, activeTabId: untitled.id });
    const mapSpy = vi.spyOn(tabs, 'map');

    try {
      const snap = snapshotFromStores();

      expect(mapSpy).not.toHaveBeenCalled();
      expect(snap.windows[0]!.editor!.openFilePaths).toEqual(['/x.md', '/y.md']);
      expect(collectEditorSnapshot.toString()).not.toContain(
        'openFilePaths.push(',
      );
      // active 是 untitled → activePath=null
      expect(snap.windows[0]!.editor!.activePath).toBeNull();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('activeTabId=null → activePath=null', () => {
    useEditorStore.setState({
      tabs: [createTab('/a.md', 'a')],
      activeTabId: null,
    });
    expect(snapshotFromStores().windows[0]!.editor!.activePath).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// hydrateEditorTabs · async
// ────────────────────────────────────────────────────────────

describe('hydrateEditorTabs', () => {
  // v2 形态主窗段 helper
  function snapWithEditor(
    openFilePaths: string[],
    activePath: string | null,
  ): ExplorerSnapshot {
    return {
      version: 2,
      workspace: { recentRoots: [] },
      pinned: { paths: [] },
      nextWindowSeq: 1,
      windows: [
        {
          windowSeq: 0,
          workspace: { root: null },
          explorer: {
            activePath: null,
            expandedPaths: [],
            sort: { by: 'name', reverse: false },
          },
          editor: { openFilePaths, activePath },
        },
      ],
    };
  }

  function snapWithoutEditor(): ExplorerSnapshot {
    return {
      version: 2,
      workspace: { recentRoots: [] },
      pinned: { paths: [] },
      nextWindowSeq: 1,
      windows: [
        {
          windowSeq: 0,
          workspace: { root: null },
          explorer: {
            activePath: null,
            expandedPaths: [],
            sort: { by: 'name', reverse: false },
          },
        },
      ],
    };
  }

  it('snap windows[0] 无 editor → noop', async () => {
    const fs = makeFs({});
    await hydrateEditorTabs(snapWithoutEditor(), fs);
    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('openFilePaths=[] → noop', async () => {
    const fs = makeFs({});
    await hydrateEditorTabs(snapWithEditor([], null), fs);
    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  // 边界(E216):openFilePaths 超 MAX_RESTORED_TABS(256)→ 截断恢复,不一次性 fan-out 海量 readFile。
  // schema 允许至多 100k openFilePaths,畸形/旧快照启动时全量并发读 → 资源耗尽。
  it('E216 openFilePaths 超 MAX_RESTORED_TABS(256)→ 只读前 256 并截断恢复', async () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 300; i++) {
      const p = `/f${i}.md`;
      files[p] = 'x';
      paths.push(p);
    }
    const fs = makeFs(files);
    await hydrateEditorTabs(snapWithEditor(paths, null), fs);
    // 中和(去 MAX_RESTORED_TABS 截断)→ readFile 调 300 次、tabs 300,断言失败。
    expect((fs.readFile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(256);
    expect(useEditorStore.getState().tabs).toHaveLength(256);
  });

  it('E216 分批恢复不再对 openFilePaths 反复 slice 出 chunk', async () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 40; i++) {
      const p = `/chunk-${i}.md`;
      files[p] = 'x';
      paths.push(p);
    }
    const fs = makeFs(files);
    const sliceSpy = vi.spyOn(paths, 'slice');

    try {
      await hydrateEditorTabs(snapWithEditor(paths, null), fs);

      expect(sliceSpy).not.toHaveBeenCalled();
      expect(hydrateEditorTabs.toString()).not.toContain('paths.push(');
      expect((fs.readFile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(40);
      expect(useEditorStore.getState().tabs).toHaveLength(40);
    } finally {
      sliceSpy.mockRestore();
    }
  });

  it('多 path → 顺序 openTab,内容来自 fs.readFile', async () => {
    const fs = makeFs({ '/a.md': 'A', '/b.md': 'B' });
    await hydrateEditorTabs(snapWithEditor(['/a.md', '/b.md'], '/a.md'), fs);
    const { tabs } = useEditorStore.getState();
    expect(tabs.map((t) => t.filePath)).toEqual(['/a.md', '/b.md']);
    expect(tabs.map((t) => t.content)).toEqual(['A', 'B']);
  });

  it('单个 readFile 失败 → 跳过该 path,其他仍恢复', async () => {
    const fs = makeFs({ '/a.md': 'A', '/c.md': 'C' }, {
      fail: new Set(['/b.md']),
    });
    await hydrateEditorTabs(
      snapWithEditor(['/a.md', '/b.md', '/c.md'], '/a.md'),
      fs,
    );
    const tabs = useEditorStore.getState().tabs;
    expect(tabs.map((t) => t.filePath)).toEqual(['/a.md', '/c.md']);
  });

  // 数据安全(codex 复查 P2):readFile 的 promise reject(桥/进程/通道异常,非 handler
  // 的 {ok:false})此前因 Promise.all 整轮抛 → hydrateEditorTabs 违反「不抛」契约 →
  // init catch 后 0 tab → 下次持久化把 openFilePaths 写空 → 丢整个编辑会话。allSettled
  // 后:单文件 reject 逐项跳过、不抛,其它 tab 仍恢复。
  it('单个 readFile promise reject(非 {ok:false})→ 不抛,跳过该 path,其他仍恢复', async () => {
    const fs = makeFs(
      { '/a.md': 'A', '/c.md': 'C' },
      { reject: new Set(['/b.md']) },
    );
    await expect(
      hydrateEditorTabs(snapWithEditor(['/a.md', '/b.md', '/c.md'], '/a.md'), fs),
    ).resolves.toBeUndefined(); // 不抛
    const tabs = useEditorStore.getState().tabs;
    expect(tabs.map((t) => t.filePath)).toEqual(['/a.md', '/c.md']); // 其它仍恢复
  });

  it('activePath 在已恢复 tabs 内 → switchTab', async () => {
    const fs = makeFs({ '/a.md': 'A', '/b.md': 'B' });
    await hydrateEditorTabs(snapWithEditor(['/a.md', '/b.md'], '/b.md'), fs);
    expect(useEditorStore.getState().activeTabId).toBe('/b.md');
  });

  it('activePath 恢复查找 helper 单趟扫描 tabs,不通过 tabs.some', () => {
    const tabs = [{ id: '/a.md' }, { id: '/b.md' }];
    const someSpy = vi.spyOn(tabs, 'some');

    try {
      expect(hasEditorTabWithId(tabs, '/b.md')).toBe(true);
      expect(someSpy).not.toHaveBeenCalled();
    } finally {
      someSpy.mockRestore();
    }
  });

  it('activePath 不在已恢复 tabs 内(被跳过)→ 不调 switchTab', async () => {
    const fs = makeFs({ '/a.md': 'A' }, { fail: new Set(['/b.md']) });
    await hydrateEditorTabs(snapWithEditor(['/a.md', '/b.md'], '/b.md'), fs);
    // openTab 自动把每个新 tab 设成 active,最后 active 是 /a.md(只剩它)
    expect(useEditorStore.getState().activeTabId).toBe('/a.md');
  });

  it('全部 readFile 失败 → tabs 空 + active null', async () => {
    const fs = makeFs({}, { fail: new Set(['/a.md', '/b.md']) });
    await hydrateEditorTabs(snapWithEditor(['/a.md', '/b.md'], '/a.md'), fs);
    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(useEditorStore.getState().activeTabId).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// initExplorerPersistence + extras.fs · 集成
// ────────────────────────────────────────────────────────────

describe('initExplorerPersistence + editor', () => {
  function makeApi(snap: ExplorerSnapshot | null): ExplorerPersistApi {
    return {
      read: vi.fn(async () => ({ ok: true as const, data: snap })),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };
  }

  function snapV2(opts: {
    workspaceRoot?: string | null;
    recentRoots?: string[];
    editor?: { openFilePaths: string[]; activePath: string | null };
  }): ExplorerSnapshot {
    return {
      version: 2,
      workspace: { recentRoots: opts.recentRoots ?? [] },
      pinned: { paths: [] },
      nextWindowSeq: 1,
      windows: [
        {
          windowSeq: 0,
          workspace: { root: opts.workspaceRoot ?? null },
          explorer: {
            activePath: null,
            expandedPaths: [],
            sort: { by: 'name', reverse: false },
          },
          ...(opts.editor ? { editor: opts.editor } : {}),
        },
      ],
    };
  }

  it('extras.fs 提供 + windows[0].editor 有 → hydrate editor tabs', async () => {
    const snap = snapV2({
      workspaceRoot: '/w',
      recentRoots: ['/w'],
      editor: { openFilePaths: ['/w/a.md'], activePath: '/w/a.md' },
    });
    const fs = makeFs({ '/w/a.md': 'hello' });
    await initExplorerPersistence(makeApi(snap), { fs });
    expect(useEditorStore.getState().tabs.map((t) => t.filePath)).toEqual([
      '/w/a.md',
    ]);
    expect(useEditorStore.getState().activeTabId).toBe('/w/a.md');
  });

  it('extras.fs 不提供 → editor 段被忽略,workspace 仍 hydrate', async () => {
    const snap = snapV2({
      workspaceRoot: '/w',
      recentRoots: ['/w'],
      editor: { openFilePaths: ['/w/a.md'], activePath: '/w/a.md' },
    });
    await initExplorerPersistence(makeApi(snap));
    expect(useWorkspaceStore.getState().root).toBe('/w');
    // editor 没 hydrate(没 fs 读不了)
    expect(useEditorStore.getState().tabs).toEqual([]);
  });

  it('snap windows[0] 无 editor 字段 → 不调 fs.readFile', async () => {
    const snap = snapV2({});
    const fs = makeFs({});
    await initExplorerPersistence(makeApi(snap), { fs });
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});
