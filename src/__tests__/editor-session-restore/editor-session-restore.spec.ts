// @vitest-environment jsdom
// BDD: editor-session-restore
// 测三层:snapshotFromStores 含 editor 字段;hydrateEditorTabs async helper;
// initExplorerPersistence 集成(fs 注入路径)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('tab 的 realPath(symlink 真实目标,runtime only)不进入持久化快照', () => {
    useEditorStore.setState({
      tabs: [createTab('/CLAUDE.md', 'x', '/AGENTS.md')],
      activeTabId: '/CLAUDE.md',
    });
    const snap = snapshotFromStores();
    expect(snap.windows[0]!.editor).toEqual({
      openFilePaths: ['/CLAUDE.md'],
      activePath: '/CLAUDE.md',
    });
    expect(JSON.stringify(snap)).not.toContain('AGENTS');
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

  it('symlink tab:readFile 带 realPath → 恢复的 tab 记下真实目标', async () => {
    const fs: EditorSessionFsApi = {
      readFile: vi.fn(async (p: string) =>
        p === '/l.md'
          ? { ok: true as const, data: 'T', realPath: '/t/T.md' }
          : { ok: true as const, data: 'A' },
      ),
    };
    await hydrateEditorTabs(snapWithEditor(['/a.md', '/l.md'], '/a.md'), fs);
    const { tabs } = useEditorStore.getState();
    expect('realPath' in tabs[0]!).toBe(false);
    expect(tabs[1]!.realPath).toBe('/t/T.md');
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

  // 性能(r3 复核):root 恢复后、编辑器 tab 并发读盘前即置 rootRestored —— 终端首轮过滤 / Splash 放行
  // 只依赖 root,不必等全部恢复 tab 读完;hydrated 仍在 tab 恢复后才置位(TerminalPanel 等既有契约不变)。
  it('编辑器 tab 读盘在途 → rootRestored 已置位且 root 已恢复,hydrated 仍为 false', async () => {
    useWorkspaceStore.setState({ hydrated: false, rootRestored: false });
    const snap = snapV2({
      workspaceRoot: '/w',
      recentRoots: ['/w'],
      editor: { openFilePaths: ['/w/a.md'], activePath: '/w/a.md' },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fs: EditorSessionFsApi = {
      readFile: vi.fn(async () => {
        await gate;
        return { ok: true as const, data: 'hello' };
      }),
    };
    const done = initExplorerPersistence(makeApi(snap), { fs });
    await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalled());
    expect(useWorkspaceStore.getState().rootRestored).toBe(true);
    expect(useWorkspaceStore.getState().root).toBe('/w');
    expect(useWorkspaceStore.getState().hydrated).toBe(false);
    release();
    await done;
    expect(useWorkspaceStore.getState().hydrated).toBe(true);
  });

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

  // r4 复审 #1:Splash 在 root 恢复后即放行,编辑器 tab 读盘仍在途;用户此时打开的文件必须仍是活动 tab
  // (恢复的 tab 照常按顺序加入,不丢会话),不能被迟到的 restore 的 openTab/switchTab 抢回上次会话文件。
  it('读盘在途时用户 openTab 新文件 → 恢复完成后活动 tab 仍是用户文件,恢复 tab 都在且进持久化', async () => {
    const snap = snapV2({
      workspaceRoot: '/w',
      recentRoots: ['/w'],
      editor: { openFilePaths: ['/w/a.md', '/w/b.md'], activePath: '/w/a.md' },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fs: EditorSessionFsApi = {
      readFile: vi.fn(async (p: string) => {
        await gate;
        return { ok: true as const, data: `content:${p}` };
      }),
    };
    const done = initExplorerPersistence(makeApi(snap), { fs });
    await vi.waitFor(() => expect(fs.readFile).toHaveBeenCalled());
    // Splash 已放行,用户打开别的文件
    useEditorStore.getState().openTab(createTab('/w/user.md', 'mine'));
    release();
    await done;
    const st = useEditorStore.getState();
    expect(st.activeTabId).toBe('/w/user.md');
    expect(st.tabs.map((t) => t.id)).toEqual(['/w/user.md', '/w/a.md', '/w/b.md']);
    const persisted = snapshotFromStores(undefined, 0).windows[0]!.editor;
    expect(persisted).toEqual({
      openFilePaths: ['/w/user.md', '/w/a.md', '/w/b.md'],
      activePath: '/w/user.md',
    });
  });

  it('读盘在途时用户切到已有 tab(switchTab)→ 恢复完成后不切回 snapshot 的 activePath', async () => {
    useEditorStore.getState().openTab(createTab('/w/u1.md', 'x'));
    useEditorStore.getState().openTab(createTab('/w/u2.md', 'y'));
    useWorkspaceStore.setState({ root: '/w' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fs: EditorSessionFsApi = {
      readFile: vi.fn(async () => {
        await gate;
        return { ok: true as const, data: 'c' };
      }),
    };
    const snap = snapV2({
      workspaceRoot: '/w',
      editor: { openFilePaths: ['/w/a.md'], activePath: '/w/a.md' },
    });
    const p = hydrateEditorTabs(snap, fs, 0);
    useEditorStore.getState().switchTab('/w/u1.md');
    release();
    await p;
    const st = useEditorStore.getState();
    expect(st.activeTabId).toBe('/w/u1.md');
    expect(st.tabs.map((t) => t.id)).toEqual(['/w/u1.md', '/w/u2.md', '/w/a.md']);
  });

  it('snap windows[0] 无 editor 字段 → 不调 fs.readFile', async () => {
    const snap = snapV2({});
    const fs = makeFs({});
    await initExplorerPersistence(makeApi(snap), { fs });
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// r4 复审 #2:持久化订阅只关心 editor 的 openFilePaths/activePath,按键不应调度写盘
// ────────────────────────────────────────────────────────────

describe('initExplorerPersistence · editor 订阅过滤', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(): Promise<ExplorerPersistApi> {
    useWorkspaceStore.setState({ root: '/w' });
    useEditorStore.getState().openTab(createTab('/w/a.md', 'a'));
    useEditorStore.getState().openTab(createTab('/w/b.md', 'b'));
    // 先让 b 变脏:之后持续输入 dirty 恒 true、chromeVersion 不变(脏标翻转本身会 bump,属 chrome 变化)
    useEditorStore.getState().updateContent('/w/b.md', 'b-dirty');
    const api: ExplorerPersistApi = {
      read: vi.fn(async () => ({ ok: true as const, data: null })),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };
    await initExplorerPersistence(api);
    vi.useFakeTimers();
    return api;
  }

  it('连续 updateContent(按键)→ 不调度持久化写', async () => {
    const api = await setup();
    const ed = useEditorStore.getState();
    for (let i = 0; i < 20; i++) ed.updateContent('/w/b.md', `b${i}`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.write).not.toHaveBeenCalled();
  });

  it('open / close / rename / switch 仍触发持久化写', async () => {
    const api = await setup();
    const steps: Array<() => void> = [
      () => useEditorStore.getState().openTab(createTab('/w/c.md', 'c')),
      () => useEditorStore.getState().switchTab('/w/a.md'),
      () => useEditorStore.getState().renamePath('/w/a.md', '/w/a2.md'),
      () => useEditorStore.getState().closeTab('/w/c.md'),
    ];
    let expected = 0;
    for (const step of steps) {
      step();
      await vi.advanceTimersByTimeAsync(1000);
      expected += 1;
      expect(api.write).toHaveBeenCalledTimes(expected);
    }
  });
});
