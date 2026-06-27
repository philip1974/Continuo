import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { MarketplaceEntry } from '../../marketplace/types';
import type { RemoteManifestSnapshot } from '../../marketplace/fetcher';

vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn(),
}));

vi.mock('../../plugins/PluginManager', () => ({
  getUserPluginManager: vi.fn(),
}));

import {
  useUpdateStore,
  MAX_MANIFEST_FETCH_CONCURRENCY,
} from '../../marketplace/update-store';
import {
  fetchMarketplaceIndex,
  fetchPluginManifest,
} from '../../marketplace/fetcher';
import { getUserPluginManager } from '../../plugins/PluginManager';

const fetchIndex = fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>;
const fetchManifest = fetchPluginManifest as unknown as ReturnType<
  typeof vi.fn
>;
const getMgr = getUserPluginManager as unknown as ReturnType<typeof vi.fn>;

function entry(id: string, name = id, repo = `me/${id}`): MarketplaceEntry {
  return {
    id,
    name,
    description: '',
    author: 'me',
    repo,
    branch: 'main',
    tags: [],
    verified: true,
  };
}

function manifest(id: string, version: string): RemoteManifestSnapshot {
  return { id, name: id, version };
}

function fakeMgr(installed: { id: string; version: string }[]) {
  return {
    listAll: () =>
      installed.map((i) => ({
        id: i.id,
        manifest: { id: i.id, name: i.id, version: i.version },
        status: 'enabled',
      })),
  };
}

describe('useUpdateStore.refresh', () => {
  beforeEach(() => {
    useUpdateStore.setState({
      remoteVersions: new Map(),
      available: [],
      checking: false,
      lastCheckedAt: null,
    });
    fetchIndex.mockReset();
    fetchManifest.mockReset();
    getMgr.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 边界(E7):远端 manifest.version 为畸形/超长数字段(不安全整数)→ 跳过该插件更新,不因
  // Infinity/字符串比较误判「有更新」显示角标/按钮。
  it('E7 远端 version 畸形(超长数字段)→ 不收录更新', async () => {
    fetchIndex.mockResolvedValue([entry('a')]);
    fetchManifest.mockImplementation(async () =>
      manifest('a', '99999999999999999999.0.0'),
    );
    getMgr.mockReturnValue(fakeMgr([{ id: 'a', version: '0.1.0' }]));

    await useUpdateStore.getState().refresh();
    const s = useUpdateStore.getState();
    expect(s.available).toHaveLength(0); // 畸形远端版本不误判有更新
  });

  it('正路径:remote > local → available 收录;remote = local → 不收', async () => {
    fetchIndex.mockResolvedValue([entry('a'), entry('b')]);
    fetchManifest.mockImplementation(async (e: MarketplaceEntry) => {
      if (e.id === 'a') return manifest('a', '0.2.0');
      return manifest('b', '0.1.0');
    });
    getMgr.mockReturnValue(
      fakeMgr([
        { id: 'a', version: '0.1.0' },
        { id: 'b', version: '0.1.0' },
      ]),
    );

    await useUpdateStore.getState().refresh();
    const s = useUpdateStore.getState();

    expect(s.checking).toBe(false);
    expect(s.lastCheckedAt).not.toBeNull();
    expect(s.available).toHaveLength(1);
    expect(s.available[0]?.id).toBe('a');
    expect(s.available[0]?.from).toBe('0.1.0');
    expect(s.available[0]?.to).toBe('0.2.0');
    expect(s.remoteVersions.get('a')).toBe('0.2.0');
    expect(s.remoteVersions.get('b')).toBe('0.1.0');
  });

  it('并发 refresh:慢的旧 refresh 后 resolve 不覆盖新 refresh 结果(topic49 第八轮 P2-X)', async () => {
    // refresh1(慢)会算出 a 有更新到 0.2.0;refresh2(快)算出 a 无更新。
    // refresh2 先完成写入 available=[];随后 refresh1 才 resolve —— gen 已过期,
    // 不应把 [a@0.2.0] 覆盖回去。
    let resolveSlowIndex!: (v: MarketplaceEntry[]) => void;
    const slowIndex = new Promise<MarketplaceEntry[]>((res) => {
      resolveSlowIndex = res;
    });
    fetchIndex.mockReturnValueOnce(slowIndex); // refresh1:慢
    fetchIndex.mockResolvedValueOnce([entry('a')]); // refresh2:快
    // fetchManifest 调用顺序:refresh2 先(快 index),refresh1 后(慢 index resolve 后)
    fetchManifest
      .mockResolvedValueOnce(manifest('a', '0.1.0')) // refresh2 → remote=local → 无更新
      .mockResolvedValueOnce(manifest('a', '0.2.0')); // refresh1 → remote>local → 有更新
    getMgr.mockReturnValue(fakeMgr([{ id: 'a', version: '0.1.0' }]));

    const p1 = useUpdateStore.getState().refresh(); // 慢,挂起
    const p2 = useUpdateStore.getState().refresh(); // 快,先完成
    await p2;
    expect(useUpdateStore.getState().available).toHaveLength(0); // refresh2:无更新

    resolveSlowIndex([entry('a')]); // 现在放行慢的 refresh1
    await p1;
    // 关键:过期的 refresh1 即使算出 [a@0.2.0] 也被 gen 守卫丢弃,不覆盖最新结果
    expect(useUpdateStore.getState().available).toHaveLength(0);
  });

  // race(R7):refresh 网络期间用户卸载插件 → 提交前 live 重读 installed,不把已卸载插件
  // 重新加入 available(否则在 dismiss 之后落库 = 角标/更新列表复活)。
  it('R7 网络期间卸载插件 → 提交时用 live installed,不复活已卸载插件', async () => {
    fetchIndex.mockResolvedValue([entry('a')]);
    fetchManifest.mockResolvedValue(manifest('a', '0.2.0')); // remote > local,旧快照会算出有更新
    // 第一次 listAll(请求前快照)含 a;第二次(提交前 live)a 已被卸载。
    getMgr
      .mockReturnValueOnce(fakeMgr([{ id: 'a', version: '0.1.0' }]))
      .mockReturnValueOnce(fakeMgr([]));

    await useUpdateStore.getState().refresh();
    expect(useUpdateStore.getState().available).toEqual([]);
  });

  it('某 manifest 失败 → 跳过它,其它正常处理', async () => {
    fetchIndex.mockResolvedValue([entry('a'), entry('b')]);
    fetchManifest.mockImplementation(async (e: MarketplaceEntry) => {
      if (e.id === 'a') throw new Error('HTTP 404');
      return manifest('b', '0.5.0');
    });
    getMgr.mockReturnValue(
      fakeMgr([
        { id: 'a', version: '0.1.0' },
        { id: 'b', version: '0.1.0' },
      ]),
    );

    await useUpdateStore.getState().refresh();
    const s = useUpdateStore.getState();

    expect(s.available.map((u) => u.id)).toEqual(['b']);
    expect(s.remoteVersions.has('a')).toBe(false);
    expect(s.remoteVersions.get('b')).toBe('0.5.0');
  });

  it('本地未装 → 不入 available', async () => {
    fetchIndex.mockResolvedValue([entry('a')]);
    fetchManifest.mockResolvedValue(manifest('a', '9.9.9'));
    getMgr.mockReturnValue(fakeMgr([])); // 没装

    await useUpdateStore.getState().refresh();
    expect(useUpdateStore.getState().available).toEqual([]);
  });

  it('PluginManager 未初始化(null) → installed 视为空,不抛', async () => {
    fetchIndex.mockResolvedValue([entry('a')]);
    fetchManifest.mockResolvedValue(manifest('a', '0.2.0'));
    getMgr.mockReturnValue(null);

    await useUpdateStore.getState().refresh();
    expect(useUpdateStore.getState().available).toEqual([]);
  });

  it('index fetch 失败 → console.warn + checking 清零,不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchIndex.mockRejectedValue(new Error('offline'));
    // R54:需有已安装插件才会走网络路径(否则空 installed 直接跳过 index fetch)
    getMgr.mockReturnValue(fakeMgr([{ id: 'a', version: '0.1.0' }]));

    await useUpdateStore.getState().refresh();
    const s = useUpdateStore.getState();

    expect(s.checking).toBe(false);
    expect(s.available).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('refresh failed'),
      expect.any(Error),
    );
  });

  it('R54:无已安装插件 → 跳过 index + manifest 网络请求', async () => {
    fetchIndex.mockResolvedValue([entry('a')]);
    fetchManifest.mockResolvedValue(manifest('a', '9.9.9'));
    getMgr.mockReturnValue(fakeMgr([])); // 没装任何插件

    await useUpdateStore.getState().refresh();
    expect(fetchIndex).not.toHaveBeenCalled();
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().available).toEqual([]);
    expect(useUpdateStore.getState().lastCheckedAt).not.toBeNull();
  });

  it('R54:只拉已安装插件命中的 entries 的 manifest(M≤N)', async () => {
    fetchIndex.mockResolvedValue([entry('a'), entry('b'), entry('c')]);
    fetchManifest.mockImplementation(async (e: MarketplaceEntry) =>
      manifest(e.id, '0.1.0'),
    );
    getMgr.mockReturnValue(fakeMgr([{ id: 'b', version: '0.1.0' }])); // 只装了 b

    await useUpdateStore.getState().refresh();
    // 只为已安装的 b 拉 manifest,不拉 a/c
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect((fetchManifest.mock.calls[0]![0] as MarketplaceEntry).id).toBe('b');
  });

  it('构建 installedIds 不对 installed list 先 map 成中间数组', async () => {
    const installedSnapshot = [
      {
        id: 'a',
        manifest: { id: 'a', name: 'a', version: '0.1.0' },
        status: 'enabled',
      },
    ];
    const mgr = { listAll: vi.fn(() => installedSnapshot) };
    fetchIndex.mockResolvedValue([entry('a')]);
    fetchManifest.mockResolvedValue(manifest('a', '0.2.0'));
    getMgr.mockReturnValue(mgr);

    const mapSpy = vi.spyOn(Array.prototype, 'map');
    try {
      await useUpdateStore.getState().refresh();
      const mapCallsOnInstalled = mapSpy.mock.contexts.filter(
        (ctx) => ctx === installedSnapshot,
      ).length;
      expect(mapCallsOnInstalled).toBe(0);
    } finally {
      mapSpy.mockRestore();
    }
    expect(useUpdateStore.getState().available.map((u) => u.id)).toEqual(['a']);
  });

  it('扫描 marketplace entries 时不再 filter 二次遍历 index 快照', async () => {
    const entriesSnapshot = [entry('a'), entry('b'), entry('c')];
    fetchIndex.mockResolvedValue(entriesSnapshot);
    fetchManifest.mockResolvedValue(manifest('b', '0.2.0'));
    getMgr.mockReturnValue(fakeMgr([{ id: 'b', version: '0.1.0' }]));

    const filterSpy = vi.spyOn(Array.prototype, 'filter');
    try {
      await useUpdateStore.getState().refresh();
      const filterCallsOnEntries = filterSpy.mock.contexts.filter(
        (ctx) => ctx === entriesSnapshot,
      ).length;
      expect(filterCallsOnEntries).toBe(0);
    } finally {
      filterSpy.mockRestore();
    }
    expect(useUpdateStore.getState().available.map((u) => u.id)).toEqual(['b']);
  });

  // race(R78):dismiss(id) 只乐观删 available,不让在途 refresh 失效。旧 refresh 在 dismiss 之后、
  // mgr.reload() 落地之前提交时,用仍是旧版本的 mgr 快照重算出同一 update 覆盖回 available(角标复活)。
  // 修复:dismiss 记目标版本,refresh 提交前过滤同版本。
  it('R78 dismiss 后在途 refresh 用旧快照不复活该 update', async () => {
    useUpdateStore.setState({
      remoteVersions: new Map(),
      available: [
        { id: 'a', name: 'a', from: '1.0.0', to: '2.0.0', entry: entry('a') },
      ],
      checking: false,
      lastCheckedAt: null,
      dismissed: new Map(),
    });
    // reload 尚未落地:mgr 仍报 a@1.0.0(< 远程 2.0.0)。
    getMgr.mockReturnValue(fakeMgr([{ id: 'a', version: '1.0.0' }]));
    fetchIndex.mockResolvedValue([entry('a')]);
    let resolveM: (m: RemoteManifestSnapshot) => void = () => {};
    fetchManifest.mockImplementation(
      () =>
        new Promise<RemoteManifestSnapshot>((res) => {
          resolveM = res;
        }),
    );

    const p = useUpdateStore.getState().refresh(); // 在途
    await vi.waitFor(() => {
      if (fetchManifest.mock.calls.length === 0) throw new Error('manifest 未请求');
    });

    // 更新成功的乐观 dismiss(此时 available 仍含 a,记录目标版本 2.0.0)。
    useUpdateStore.getState().dismiss('a');
    expect(useUpdateStore.getState().available.map((u) => u.id)).toEqual([]);

    // 在途 refresh 提交:mgr 仍 a@1.0.0 < 2.0.0,但 dismissed{a:2.0.0} 过滤掉 → 不复活。
    resolveM(manifest('a', '2.0.0'));
    await p;
    expect(useUpdateStore.getState().available.map((u) => u.id)).toEqual([]);
  });

  // 边界(E234,E216 并发 fan-out 同族):manifest 拉取用有界并发池,最大同时在途 fetch 数
  // ≤ MAX_MANIFEST_FETCH_CONCURRENCY。旧 `Promise.allSettled(relevant.map(...))` 会同时发起全部(可达
  // index 4096 / 本地目录 1024),打爆网络/renderer。N 远大于上限时,峰值在途数应恰好钳到上限。
  it('E234 manifest 拉取有界并发(峰值在途 ≤ MAX_MANIFEST_FETCH_CONCURRENCY)', async () => {
    const N = 50; // 远大于上限(12),不限并发则会同时发起 50 个
    const ids = Array.from({ length: N }, (_, i) => `p${String(i).padStart(3, '0')}`);
    fetchIndex.mockResolvedValue(ids.map((id) => entry(id)));
    getMgr.mockReturnValue(fakeMgr(ids.map((id) => ({ id, version: '0.1.0' }))));

    let inFlight = 0;
    let maxInFlight = 0;
    const releasers: (() => void)[] = [];
    fetchManifest.mockImplementation((e: MarketplaceEntry) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<RemoteManifestSnapshot>((res) => {
        releasers.push(() => {
          inFlight -= 1;
          res(manifest(e.id, '0.1.0'));
        });
      });
    });

    const p = useUpdateStore.getState().refresh();
    // 逐个放行在途 fetch:每放行一个,池中空出的 worker 会启动下一个(push 新 releaser)。
    let released = 0;
    while (released < N) {
      await vi.waitFor(() => {
        if (releasers.length <= released) throw new Error('等待下一个 fetch 启动');
      });
      releasers[released]!();
      released += 1;
      await Promise.resolve(); // 让池调度下一个
    }
    await p;

    // 峰值在途恰好钳到上限(N > 上限,池一开始就填满 worker)。
    expect(maxInFlight).toBe(MAX_MANIFEST_FETCH_CONCURRENCY);
    // 全部 50 个最终都拉取过(单失败不影响其它的 allSettled 语义保留)。
    expect(fetchManifest).toHaveBeenCalledTimes(N);
  });

  it('refresh 期间 checking=true', async () => {
    let release: () => void = () => {};
    fetchIndex.mockReturnValue(
      new Promise<MarketplaceEntry[]>((resolve) => {
        release = () => resolve([]);
      }),
    );
    // R54:有已安装插件才走网络路径(index fetch 被 held → checking 维持 true)
    getMgr.mockReturnValue(fakeMgr([{ id: 'a', version: '0.1.0' }]));

    const p = useUpdateStore.getState().refresh();
    expect(useUpdateStore.getState().checking).toBe(true);
    release();
    await p;
    expect(useUpdateStore.getState().checking).toBe(false);
  });
});
