import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useExplorerStore } from '../../stores/explorer.store';
import { usePinnedStore } from '../../stores/pinned.store';
import {
  SIDEBAR_DEFAULT_WIDTH,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
import {
  collectNormalizedWorkspaceRoots,
  hydrateStores,
  initExplorerPersistence,
  flushExplorerPersistence,
  snapshotFromStores,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';

const RESET = () => {
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
};

beforeEach(() => {
  RESET();
});

const fullSnapshot: ExplorerSnapshot = {
  version: 3,
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
  it('从三 store 拼出 ExplorerSnapshot v3 writable subset,Set 转 array', () => {
    useWorkspaceStore.setState({ root: '/work', recentRoots: ['/work'] });
    useExplorerStore.setState({
      expandedPaths: new Set(['/work', '/work/sub']),
      sort: { by: 'size', reverse: false },
    });
    usePinnedStore.setState({ paths: ['/p'] });

    const snap = snapshotFromStores();
    expect(snap.version).toBe(3);
    expect(snap.workspace).toEqual({ recentRoots: ['/work'] });
    expect(snap.pinned).toEqual({ paths: ['/p'] });
    expect(snap.windows).toHaveLength(1);
    const w0 = snap.windows[0]!;
    expect(w0.windowSeq).toBe(0);
    expect(w0.workspace).toEqual({ root: '/work' });
    // 打磨 R18:activePath 已不在 runtime store,snapshot 写保留位 null。
    expect(w0.explorer.activePath).toBeNull();
    expect(new Set(w0.explorer.expandedPaths)).toEqual(
      new Set(['/work', '/work/sub']),
    );
    expect(w0.explorer.sort).toEqual({ by: 'size', reverse: false });
  });

  it('snapshot recentRoots 归一化单次遍历,不对 recentRoots 数组 map 出中间数组', () => {
    const recentRoots = ['/work', '', '   ', '/old'];
    useWorkspaceStore.setState({ root: '/work', recentRoots });
    const mapSpy = vi.spyOn(recentRoots, 'map');

    try {
      const snap = snapshotFromStores();

      expect(mapSpy).not.toHaveBeenCalled();
      expect(snap.workspace.recentRoots).toEqual(['/work', '/old']);
      expect(collectNormalizedWorkspaceRoots.toString()).not.toContain(
        'out.push(',
      );
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('snapshot 不含 search 字段(打磨 R19:search 已从 store 移除)', () => {
    const w0 = snapshotFromStores().windows[0]! as unknown as Record<
      string,
      unknown
    >;
    const ex = w0['explorer'] as Record<string, unknown>;
    expect(ex).not.toHaveProperty('search');
  });

  it('不写 main-owned layout / lastClosedAt 字段', () => {
    const snap = snapshotFromStores({
      ...fullSnapshot,
      windows: [
        {
          ...fullSnapshot.windows[0]!,
          layout: { version: 1, dock: true },
          lastClosedAt: 123,
        },
      ],
    });
    const w0 = snap.windows[0]! as unknown as Record<string, unknown>;
    expect(w0).not.toHaveProperty('layout');
    expect(w0).not.toHaveProperty('lastClosedAt');
  });
});

// ──────────────── hydrateStores ────────────────

describe('hydrateStores', () => {
  it('从 ExplorerSnapshot 恢复三 store,array 转 Set', () => {
    hydrateStores(fullSnapshot);
    expect(useWorkspaceStore.getState().root).toBe('/work');
    expect(useWorkspaceStore.getState().recentRoots).toEqual(['/work', '/old']);
    // 打磨 R18:explorer.activePath 已从 store 移除,hydrate 不再回写它(磁盘
    // 里的旧值被忽略);expandedPaths / sort 仍正常恢复。
    expect(useExplorerStore.getState().expandedPaths).toEqual(
      new Set(['/work', '/work/sub']),
    );
    expect(useExplorerStore.getState().sort).toEqual({ by: 'mtime', reverse: true });
    expect(usePinnedStore.getState().paths).toEqual(['/work/star.md']);
  });

  it('hydrate recentRoots 归一化单次遍历,不对 snapshot recentRoots 数组 map 出中间数组', () => {
    const recentRoots = ['/work', '', '   ', '/old'];
    const mapSpy = vi.spyOn(recentRoots, 'map');
    const snap: ExplorerSnapshot = {
      ...fullSnapshot,
      workspace: { recentRoots },
    };

    try {
      hydrateStores(snap);

      expect(mapSpy).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().recentRoots).toEqual(['/work', '/old']);
    } finally {
      mapSpy.mockRestore();
    }
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
      version: 3,
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

  it('hydrate v3 full snapshot 含 main-owned layout / lastClosedAt 不抛且忽略', () => {
    const snap: ExplorerSnapshot = {
      ...fullSnapshot,
      windows: [
        {
          ...fullSnapshot.windows[0]!,
          layout: { version: 1, dock: { panels: [] } },
          lastClosedAt: 456,
        },
      ],
    };

    expect(() => hydrateStores(snap)).not.toThrow();
    expect(useWorkspaceStore.getState().root).toBe('/work');
    expect(useExplorerStore.getState().expandedPaths).toEqual(
      new Set(['/work', '/work/sub']),
    );
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

  // 数据安全(codex 复查 P1):read 失败(EACCES/EIO → ok:false)= 不可信加载,store 仍默认态。
  // 此时**不得**注册写订阅 —— 否则后续任意变化把默认态 snapshot 写盘 → main merge 覆盖真实
  // recentRoots/pinned/window/editor。
  it('read 失败(ok=false)→ 不注册写订阅:后续 store 变化不调用 api.write', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(async () => ({
        ok: false as const,
        code: 'EACCES',
        message: 'denied',
      }));
      await initExplorerPersistence(api);
      useWorkspaceStore.getState().setRoot('/a');
      useExplorerStore.getState().toggleExpand('/a');
      await vi.advanceTimersByTimeAsync(400);
      expect(api.write).not.toHaveBeenCalled(); // 不可信加载 → 绝不写盘
    } finally {
      vi.useRealTimers();
    }
  });

  it('read reject(promise 异常)→ 同样不注册写订阅', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(async () => {
        throw new Error('bridge crash');
      });
      await initExplorerPersistence(api);
      useWorkspaceStore.getState().setRoot('/a');
      await vi.advanceTimersByTimeAsync(400);
      expect(api.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
      expect(written.version).toBe(3);
      const w0 = written.windows.find((w) => w.windowSeq === 0)!;
      expect(w0.workspace.root).toBe('/b');
      expect(w0.explorer.expandedPaths).toContain('/a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('自动保存成功后 flush 相同 snapshot → 不重复调用 api.write', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi(async () => ({ ok: true, data: null }));
      await initExplorerPersistence(api);

      useWorkspaceStore.getState().setRoot('/a');
      await vi.advanceTimersByTimeAsync(400);
      expect(api.write).toHaveBeenCalledTimes(1);

      await flushExplorerPersistence();
      expect(api.write).toHaveBeenCalledTimes(1);
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

  // race(R87):debounce 自动写与关窗 flush 并发时,写必须串行 —— 旧 snapshot 不得在新之后落盘。
  it('R87 写串行:in-flight 写期间的 flush 不并发调 api.write,且最终落最新 snapshot', async () => {
    vi.useFakeTimers();
    try {
      const writeCalls: ExplorerSnapshot[] = [];
      const resolvers: Array<() => void> = [];
      const api: ExplorerPersistApi = {
        read: async () => ({ ok: true, data: null }),
        write: vi.fn((snap: ExplorerSnapshot) => {
          writeCalls.push(snap);
          return new Promise<{ ok: true; data: undefined }>((r) => {
            resolvers.push(() => r({ ok: true, data: undefined }));
          });
        }),
      };
      await initExplorerPersistence(api);

      // 写#1:root=/a → debounce 触发 → writeNow#1 → api.write#1(deferred,在途)。
      useWorkspaceStore.getState().setRoot('/a');
      await vi.advanceTimersByTimeAsync(400);
      expect(writeCalls.length).toBe(1);

      // #1 在途时改 store + 关窗 flush → writeNow#2。单飞:不并发调 api.write。
      useWorkspaceStore.getState().setRoot('/b');
      const flushP = flushExplorerPersistence();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeCalls.length).toBe(1); // 关键:#2 排队,未与 #1 并发

      // 放行 #1 → 链推进 → #2 执行,执行时重读最新 snap(root=/b)。
      resolvers[0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeCalls.length).toBe(2);

      resolvers[1]!();
      await flushP;

      // 最后落盘的是最新态 root=/b(旧 /a 不在新之后覆盖)。
      const last = writeCalls[writeCalls.length - 1]!;
      const w0 = last.windows.find((w) => w.windowSeq === 0)!;
      expect(w0.workspace.root).toBe('/b');
    } finally {
      vi.useRealTimers();
    }
  });

  // ──── 多窗口 Phase 2B(issue #23):windowSeq + initialWorkspace ────
  describe('windowSeq + initialWorkspace(多窗口持久化路径)', () => {
    // fullSnapshot 含 windows[0],新窗 windowSeq=1 段不存在
    const NEW_SEQ = 1;

    it('新 windowSeq 段不存在 + initialWorkspace 给 → workspace.root 用 query', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      await initExplorerPersistence(api, {
        windowSeq: NEW_SEQ,
        initialWorkspace: '/new/window/proj',
      });
      expect(useWorkspaceStore.getState().root).toBe('/new/window/proj');
    });

    it('新窗 → recentRoots / pinned 仍读全局段', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      await initExplorerPersistence(api, {
        windowSeq: NEW_SEQ,
        initialWorkspace: '/new/proj',
      });
      expect(useWorkspaceStore.getState().recentRoots).toEqual(['/work', '/old']);
      expect(usePinnedStore.getState().paths).toEqual(['/work/star.md']);
    });

    it('新窗 → expandedPaths 用默认(每窗口独立 UI)', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      await initExplorerPersistence(api, {
        windowSeq: NEW_SEQ,
        initialWorkspace: '/new/proj',
      });
      expect(useExplorerStore.getState().expandedPaths.size).toBe(0);
    });

    it('新窗 → layoutUi 用默认(每窗口独立 sidebar 状态)', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      await initExplorerPersistence(api, {
        windowSeq: NEW_SEQ,
        initialWorkspace: '/new/proj',
      });
      expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
      expect(useLayoutUiStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    });

    it('新窗 → 订阅 persist,write 只写自己段(windowSeq=1),不携带主窗段', async () => {
      // 行为变更(topic 49 第七轮 P1-U):renderer 只写自己这一段,**不**携带
      // 启动时读到的其它窗口段(会是陈旧的)。保留其它窗口最新段由 main 的
      // explorer:write merge 在 file-mutex 内重读磁盘完成,不再靠 renderer 携带。
      vi.useFakeTimers();
      try {
        const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
        await initExplorerPersistence(api, {
          windowSeq: NEW_SEQ,
          initialWorkspace: '/new/proj',
        });
        useExplorerStore.getState().toggleExpand('/new/proj/sub');
        await vi.advanceTimersByTimeAsync(400);
        expect(api.write).toHaveBeenCalledTimes(1);
        const written = (api.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExplorerSnapshot;
        // 只写自己段:不含主窗 seq 0 的陈旧段(避免回退别窗最新状态)
        expect(written.windows).toHaveLength(1);
        expect(written.windows.find((w) => w.windowSeq === 0)).toBeUndefined();
        // 自己段写入新值
        const w1 = written.windows.find((w) => w.windowSeq === 1)!;
        expect(w1.workspace.root).toBe('/new/proj');
        expect(w1.explorer.expandedPaths).toContain('/new/proj/sub');
      } finally {
        vi.useRealTimers();
      }
    });

    it('新窗 + 磁盘空 explorer.json → workspace.root 用 query,其他默认,write 写自己段', async () => {
      vi.useFakeTimers();
      try {
        const api = makeApi(async () => ({ ok: true, data: null }));
        await initExplorerPersistence(api, {
          windowSeq: NEW_SEQ,
          initialWorkspace: '/fresh',
        });
        expect(useWorkspaceStore.getState().root).toBe('/fresh');
        expect(useWorkspaceStore.getState().recentRoots).toEqual([]);
        useExplorerStore.getState().toggleExpand('/fresh/x');
        await vi.advanceTimersByTimeAsync(400);
        const written = (api.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as ExplorerSnapshot;
        expect(written.windows.find((w) => w.windowSeq === 1)?.workspace.root).toBe('/fresh');
      } finally {
        vi.useRealTimers();
      }
    });

    it('windowSeq 段已存在(重启恢复)→ 按段 hydrate,query workspace 忽略', async () => {
      const api = makeApi(async () => ({ ok: true, data: fullSnapshot }));
      // windowSeq=0 (主窗段存在),哪怕 initialWorkspace='/wrong',也按段恢复
      await initExplorerPersistence(api, {
        windowSeq: 0,
        initialWorkspace: '/wrong/should/be/ignored',
      });
      expect(useWorkspaceStore.getState().root).toBe('/work');
    });
  });
});
