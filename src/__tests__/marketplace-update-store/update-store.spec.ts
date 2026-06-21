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

import { useUpdateStore } from '../../marketplace/update-store';
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
