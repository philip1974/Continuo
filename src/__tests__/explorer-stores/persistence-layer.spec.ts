import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useExplorerStore } from '../../stores/explorer.store';
import { usePinnedStore } from '../../stores/pinned.store';
import {
  SIDEBAR_DEFAULT_WIDTH,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
import {
  hydrateStores,
  initExplorerPersistence,
  snapshotFromStores,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';

const RESET = () => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useExplorerStore.setState({
    activePath: null,
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
    search: '',
  });
  usePinnedStore.setState({ paths: [] });
  useLayoutUiStore.setState({
    sidebarOpen: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
};

beforeEach(() => {
  RESET();
});

const fullSnapshot: ExplorerSnapshot = {
  version: 2,
  workspace: { recentRoots: ['/work', '/old'] },
  pinned: { paths: ['/work/star.md'] },
  nextWindowSeq: 1,
  windows: [
    {
      windowSeq: 0,
      workspace: { root: '/work' },
      explorer: {
        activePath: '/work/file.md',
        expandedPaths: ['/work', '/work/sub'],
        sort: { by: 'mtime', reverse: true },
      },
      layoutUi: { sidebarOpen: false, sidebarWidth: 320 },
    },
  ],
};

// ──────────────── snapshotFromStores ────────────────

describe('snapshotFromStores', () => {
  it('从三 store 拼出 ExplorerSnapshot v2,Set 转 array', () => {
    useWorkspaceStore.setState({ root: '/work', recentRoots: ['/work'] });
    useExplorerStore.setState({
      activePath: '/work/file',
      expandedPaths: new Set(['/work', '/work/sub']),
      sort: { by: 'size', reverse: false },
    });
    usePinnedStore.setState({ paths: ['/p'] });

    const snap = snapshotFromStores();
    expect(snap.version).toBe(2);
    expect(snap.workspace).toEqual({ recentRoots: ['/work'] });
    expect(snap.pinned).toEqual({ paths: ['/p'] });
    expect(snap.windows).toHaveLength(1);
    const w0 = snap.windows[0]!;
    expect(w0.windowSeq).toBe(0);
    expect(w0.workspace).toEqual({ root: '/work' });
    expect(w0.explorer.activePath).toBe('/work/file');
    expect(new Set(w0.explorer.expandedPaths)).toEqual(
      new Set(['/work', '/work/sub']),
    );
    expect(w0.explorer.sort).toEqual({ by: 'size', reverse: false });
  });

  it('不持久化 search 等瞬时字段', () => {
    useExplorerStore.setState({
      search: 'foo',
    });
    const w0 = snapshotFromStores().windows[0]! as unknown as Record<
      string,
      unknown
    >;
    const ex = w0['explorer'] as Record<string, unknown>;
    expect(ex).not.toHaveProperty('search');
  });
});

// ──────────────── hydrateStores ────────────────

describe('hydrateStores', () => {
  it('从 ExplorerSnapshot 恢复三 store,array 转 Set', () => {
    hydrateStores(fullSnapshot);
    expect(useWorkspaceStore.getState().root).toBe('/work');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/work', '/old']);
    expect(useExplorerStore.getState().activePath).toBe('/work/file.md');
    expect(useExplorerStore.getState().expandedPaths).toEqual(
      new Set(['/work', '/work/sub']),
    );
    expect(useExplorerStore.getState().sort).toEqual({ by: 'mtime', reverse: true });
    expect(usePinnedStore.getState().paths).toEqual(['/work/star.md']);
  });

  it('hydrate 显式复位 search 瞬时字段', () => {
    useExplorerStore.setState({
      search: 'keep',
    });
    hydrateStores(fullSnapshot);
    // 重启后被复位为初态(空),不带入磁盘数据(因为根本没存)
    expect(useExplorerStore.getState().search).toBe('');
  });

  it('hydrate 含 layoutUi → 写到 useLayoutUiStore', () => {
    hydrateStores(fullSnapshot);
    const ui = useLayoutUiStore.getState();
    expect(ui.sidebarOpen).toBe(false);
    expect(ui.sidebarWidth).toBe(320);
  });

  it('hydrate 不含 layoutUi(windows[0] 缺 layoutUi)→ 复位默认', () => {
    // 先脏 store
    useLayoutUiStore.setState({ sidebarOpen: false, sidebarWidth: 999 });
    const snapWithoutUi: ExplorerSnapshot = {
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
    hydrateStores(snapWithoutUi);
    const ui = useLayoutUiStore.getState();
    expect(ui.sidebarOpen).toBe(true);
    expect(ui.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('hydrate 时 sidebarWidth 越界 → clamp 到合法范围(防磁盘脏数据)', () => {
    const overrideUi = (sidebarWidth: number): ExplorerSnapshot => ({
      ...fullSnapshot,
      windows: [
        {
          ...fullSnapshot.windows[0]!,
          layoutUi: { sidebarOpen: true, sidebarWidth },
        },
      ],
    });
    hydrateStores(overrideUi(9999));
    expect(useLayoutUiStore.getState().sidebarWidth).toBeLessThanOrEqual(500);
    hydrateStores(overrideUi(1));
    expect(useLayoutUiStore.getState().sidebarWidth).toBeGreaterThanOrEqual(200);
  });
});

describe('snapshotFromStores · layoutUi', () => {
  it('windows[0].layoutUi 来自 useLayoutUiStore 当前状态', () => {
    useLayoutUiStore.setState({ sidebarOpen: false, sidebarWidth: 350 });
    const snap = snapshotFromStores();
    expect(snap.windows[0]!.layoutUi).toEqual({
      sidebarOpen: false,
      sidebarWidth: 350,
    });
  });
});

// ──────────────── initExplorerPersistence ────────────────

describe('initExplorerPersistence', () => {
  function makeApi(read: ExplorerPersistApi['read']): ExplorerPersistApi {
    return {
      read,
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };
  }

  it('read 成功 + 有数据 → hydrate', async () => {
    const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
    await initExplorerPersistence(api);
    expect(useWorkspaceStore.getState().root).toBe('/work');
  });

  it('read 成功 + 数据为 null(首次启动) → 不 hydrate,store 保持初态', async () => {
    const api = makeApi(async () => ({ ok: true, data: null }));
    await initExplorerPersistence(api);
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it('read 失败 → 不 crash,store 保持初态', async () => {
    const api = makeApi(async () => ({
      ok: false as const,
      code: 'IPC_DENIED',
      message: 'oops',
    }));
    await expect(initExplorerPersistence(api)).resolves.toBeUndefined();
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it('read 数据非合法 schema → 不 hydrate(降级到初态),不 crash', async () => {
    const api = makeApi(async () => ({
      ok: true,
      data: { version: 999, garbage: true } as unknown,
    }));
    await expect(initExplorerPersistence(api)).resolves.toBeUndefined();
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  it('store 变化触发 debounce write(fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(async () => ({ ok: true, data: null }));
      await initExplorerPersistence(api);

      // 三次连续变化,应被 debounce 合并为 1 次写
      useWorkspaceStore.getState().setRoot('/a');
      useWorkspaceStore.getState().setRoot('/b');
      useExplorerStore.getState().toggleExpand('/a');

      // 推进时钟,触发 debounce
      await vi.advanceTimersByTimeAsync(400);
      expect(api.write).toHaveBeenCalledTimes(1);

      // write 入参带最新状态(主窗段)
      const call = (api.write as ReturnType<typeof vi.fn>).mock.calls[0];
      const written = call?.[0] as ExplorerSnapshot;
      expect(written.version).toBe(2);
      const w0 = written.windows.find((w) => w.windowSeq === 0)!;
      expect(w0.workspace.root).toBe('/b');
      expect(w0.explorer.expandedPaths).toContain('/a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('write 失败时不 crash(只 console.warn)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api: ExplorerPersistApi = {
        read: async () => ({ ok: true, data: null }),
        write: async () => ({ ok: false as const, code: 'FS_IO', message: 'disk full' }),
      };
      await initExplorerPersistence(api);
      useWorkspaceStore.getState().setRoot('/a');
      await vi.advanceTimersByTimeAsync(400);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  // ──── 多窗口 Phase 1(issue #23):initialWorkspace ────
  describe('initialWorkspace(新窗口启动路径)', () => {
    it('initialWorkspace 给定 → workspace.root 用此值,不读 explorer.json 的 workspace.root', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      await initExplorerPersistence(api, { initialWorkspace: '/new/window/proj' });
      expect(useWorkspaceStore.getState().root).toBe('/new/window/proj');
    });

    it('initialWorkspace + explorer.json 有 → recentRoots / pinned 仍读全局段', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      await initExplorerPersistence(api, { initialWorkspace: '/new/proj' });
      expect(useWorkspaceStore.getState().recentRoots).toEqual(['/work', '/old']);
      expect(usePinnedStore.getState().paths).toEqual(['/work/star.md']);
    });

    it('initialWorkspace → expandedPaths / activePath 用默认(每窗口独立 UI)', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      await initExplorerPersistence(api, { initialWorkspace: '/new/proj' });
      expect(useExplorerStore.getState().expandedPaths.size).toBe(0);
      expect(useExplorerStore.getState().activePath).toBeNull();
    });

    it('initialWorkspace → layoutUi 用默认(每窗口独立 sidebar 状态)', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      await initExplorerPersistence(api, { initialWorkspace: '/new/proj' });
      expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
      expect(useLayoutUiStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    });

    it('initialWorkspace → 不订阅 persist,store 变化不触发 write(避免覆盖主窗持久化)', async () => {
      vi.useFakeTimers();
      try {
        const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
        await initExplorerPersistence(api, { initialWorkspace: '/new/proj' });
        useWorkspaceStore.getState().setRoot('/changed');
        await vi.advanceTimersByTimeAsync(400);
        expect(api.write).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('initialWorkspace + explorer.json 缺 → workspace.root 仍用 initialWorkspace,其他默认', async () => {
      const api = makeApi(async () => ({ ok: true, data: null }));
      await initExplorerPersistence(api, { initialWorkspace: '/fresh' });
      expect(useWorkspaceStore.getState().root).toBe('/fresh');
      expect(useWorkspaceStore.getState().recentRoots).toEqual([]);
    });
  });
});
