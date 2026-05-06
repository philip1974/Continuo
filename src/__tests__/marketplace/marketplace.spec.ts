// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// 让 marketplace fetcher 走 globalThis.fetch(测试 mock 的);生产 PROD
// 模式 fetcher 才需要 getCachedFetch 拿 raw ref(防 sandboxSweep 涂掉
// globalThis.fetch)。
vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => globalThis.fetch,
  getCachedClipboard: () => ({
    readText: () => Promise.resolve(''),
    writeText: () => Promise.resolve(),
  }),
  sandboxSweep: () => {},
}));

import {
  _resetMarketplaceCacheForTest,
  fetchMarketplaceIndex,
} from '../../marketplace/fetcher';
import {
  entryToGitUrl,
  entryToManifestUrl,
  type MarketplaceEntry,
} from '../../marketplace/types';

const SAMPLE_ENTRY: MarketplaceEntry = {
  id: 'com.example.foo',
  name: 'Foo',
  description: 'desc',
  author: 'me',
  repo: 'me/foo-plugin',
  branch: 'main',
  tags: ['demo'],
  verified: true,
};

describe('entryToGitUrl', () => {
  it('拼成 https://github.com/owner/name.git', () => {
    expect(entryToGitUrl(SAMPLE_ENTRY)).toBe(
      'https://github.com/me/foo-plugin.git',
    );
  });
});

describe('entryToManifestUrl', () => {
  it('用 entry.branch', () => {
    expect(entryToManifestUrl({ ...SAMPLE_ENTRY, branch: 'dev' })).toBe(
      'https://raw.githubusercontent.com/me/foo-plugin/dev/manifest.json',
    );
  });

  it('缺 branch → 默认 main', () => {
    const { branch: _b, ...withoutBranch } = SAMPLE_ENTRY;
    expect(entryToManifestUrl(withoutBranch)).toBe(
      'https://raw.githubusercontent.com/me/foo-plugin/main/manifest.json',
    );
  });
});

describe('fetchMarketplaceIndex', () => {
  beforeEach(() => {
    _resetMarketplaceCacheForTest();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(response: { ok: boolean; status?: number; data?: unknown }) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(response.data ?? []), {
        status: response.ok ? 200 : (response.status ?? 500),
      }),
    );
  }

  it('首次拉 → 网络 fetch + 写 cache', async () => {
    const f = mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    const r = await fetchMarketplaceIndex();
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('com.example.foo');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('1h 内复拉 → 命中 cache 不再走网络', async () => {
    const f = mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    await fetchMarketplaceIndex();
    await fetchMarketplaceIndex();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh=true → 跳过 cache 重 fetch', async () => {
    const f = mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    await fetchMarketplaceIndex();
    await fetchMarketplaceIndex(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('网络失败 + 无 cache → 抛', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(fetchMarketplaceIndex()).rejects.toThrow(/offline/);
  });

  it('网络失败 + 有 cache → 回落 cache(过期也返)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 先填 cache
    mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    await fetchMarketplaceIndex();

    // 网络断
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const r = await fetchMarketplaceIndex(true);
    expect(r).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to cache'),
      expect.anything(),
    );
  });

  it('HTTP 非 2xx → 当作失败,无 cache 时抛', async () => {
    mockFetch({ ok: false, status: 503 });
    await expect(fetchMarketplaceIndex()).rejects.toThrow(/HTTP 503/);
  });

  it('返回非数组 → 抛', async () => {
    mockFetch({ ok: true, data: { not: 'array' } });
    await expect(fetchMarketplaceIndex()).rejects.toThrow(/index 非数组/);
  });

  it('sessionStorage hydrate:memory 空时从 sessionStorage 读', async () => {
    // 模拟"已经写过 sessionStorage,但 memory 是空"
    sessionStorage.setItem(
      'continuo:marketplace:index',
      JSON.stringify({
        fetchedAt: Date.now(),
        entries: [SAMPLE_ENTRY],
      }),
    );
    const f = mockFetch({ ok: true, data: [] });
    const r = await fetchMarketplaceIndex();
    expect(r).toHaveLength(1);
    expect(f).not.toHaveBeenCalled(); // sessionStorage 命中,没走网络
  });
});
