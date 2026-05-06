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
  version: 1,
  workspace: { root: '/work', recentRoots: ['/work', '/old'] },
  explorer: {
    activePath: '/work/file.md',
    expandedPaths: ['/work', '/work/sub'],
    sort: { by: 'mtime', reverse: true },
  },
  pinned: { paths: ['/work/star.md'] },
  layoutUi: { sidebarOpen: false, sidebarWidth: 320 },
};

// ──────────────── snapshotFromStores ────────────────

describe('snapshotFromStores', () => {
  it('从三 store 拼出 ExplorerSnapshot,Set 转 array', () => {
    useWorkspaceStore.setState({ root: '/work', recentRoots: ['/work'] });
    useExplorerStore.setState({
      activePath: '/work/file',
      expandedPaths: new Set(['/work', '/work/sub']),
      sort: { by: 'size', reverse: false },
    });
    usePinnedStore.setState({ paths: ['/p'] });

    const snap = snapshotFromStores();
    expect(snap.version).toBe(1);
    expect(snap.workspace).toEqual({ root: '/work', recentRoots: ['/work'] });
    expect(snap.explorer.activePath).toBe('/work/file');
    expect(new Set(snap.explorer.expandedPaths)).toEqual(
      new Set(['/work', '/work/sub']),
    );
    expect(snap.explorer.sort).toEqual({ by: 'size', reverse: false });
    expect(snap.pinned).toEqual({ paths: ['/p'] });
  });

  it('不持久化 search 等瞬时字段', () => {
    useExplorerStore.setState({
      search: 'foo',
    });
    const explorerJson = snapshotFromStores().explorer as unknown as Record<string, unknown>;
    expect(explorerJson).not.toHaveProperty('search');
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

  it('hydrate 不含 layoutUi(旧 explorer.json 向下兼容)→ 复位默认', () => {
    // 先脏 store
    useLayoutUiStore.setState({ sidebarOpen: false, sidebarWidth: 999 });
    const snapWithoutUi: ExplorerSnapshot = {
      version: 1,
      workspace: { root: null, recentRoots: [] },
      explorer: {
        activePath: null,
        expandedPaths: [],
        sort: { by: 'name', reverse: false },
      },
      pinned: { paths: [] },
    };
    hydrateStores(snapWithoutUi);
    const ui = useLayoutUiStore.getState();
    expect(ui.sidebarOpen).toBe(true);
    expect(ui.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('hydrate 时 sidebarWidth 越界 → clamp 到合法范围(防磁盘脏数据)', () => {
    hydrateStores({
      ...fullSnapshot,
      layoutUi: { sidebarOpen: true, sidebarWidth: 9999 },
    });
    expect(useLayoutUiStore.getState().sidebarWidth).toBeLessThanOrEqual(500);

    hydrateStores({
      ...fullSnapshot,
      layoutUi: { sidebarOpen: true, sidebarWidth: 1 },
    });
    expect(useLayoutUiStore.getState().sidebarWidth).toBeGreaterThanOrEqual(200);
  });
});

describe('snapshotFromStores · layoutUi', () => {
  it('包含 sidebarOpen 与 sidebarWidth(从 useLayoutUiStore 读)', () => {
    useLayoutUiStore.setState({ sidebarOpen: false, sidebarWidth: 350 });
    const snap = snapshotFromStores();
    expect(snap.layoutUi).toEqual({ sidebarOpen: false, sidebarWidth: 350 });
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

      // write 入参带最新状态
      const call = (api.write as ReturnType<typeof vi.fn>).mock.calls[0];
      const written = call?.[0] as ExplorerSnapshot;
      expect(written.workspace.root).toBe('/b');
      expect(written.explorer.expandedPaths).toContain('/a');
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
});
