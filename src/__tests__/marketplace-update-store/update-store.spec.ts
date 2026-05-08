import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { MarketplaceEntry } from '../../marketplace/types';
import type { RemoteManifestSnapshot } from '../../marketplace/fetcher';

vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn(),
}));

vi.mock('../../plugins/co-plugin-manager', () => ({
  getUserPluginManager: vi.fn(),
}));

import { useUpdateStore } from '../../marketplace/update-store';
import {
  fetchMarketplaceIndex,
  fetchPluginManifest,
} from '../../marketplace/fetcher';
import { getUserPluginManager } from '../../plugins/co-plugin-manager';

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

    await useUpdateStore.getState().refresh();
    const s = useUpdateStore.getState();

    expect(s.checking).toBe(false);
    expect(s.available).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('refresh failed'),
      expect.any(Error),
    );
  });

  it('refresh 期间 checking=true', async () => {
    let release: () => void = () => {};
    fetchIndex.mockReturnValue(
      new Promise<MarketplaceEntry[]>((resolve) => {
        release = () => resolve([]);
      }),
    );
    getMgr.mockReturnValue(fakeMgr([]));

    const p = useUpdateStore.getState().refresh();
    expect(useUpdateStore.getState().checking).toBe(true);
    release();
    await p;
    expect(useUpdateStore.getState().checking).toBe(false);
  });
});
