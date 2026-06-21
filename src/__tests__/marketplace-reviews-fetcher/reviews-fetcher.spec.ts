// @vitest-environment jsdom
// 安全 S4:token + GitHub fetch 已移到 main(IPC)。renderer 只 mock
// coApi.marketplace.fetchReviews(返 IpcResult<FetchReviewsResult>),验证 parse/aggregate
// /cache/降级逻辑。renderer 再无 VITE_GITHUB_TOKEN / 直连 fetch。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fetchReviewsMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/co-api', () => ({
  coApi: { marketplace: { fetchReviews: fetchReviewsMock } },
}));

import {
  _resetReviewsCacheForTest,
  fetchAllReviews,
} from '../../marketplace/reviews-fetcher';
import type {
  FetchReviewsResult,
  MarketplaceReviewNode,
} from '../../../electron/shared/marketplace-channels';

const AUTHOR = {
  login: 'alice',
  avatarUrl: 'https://x/a',
  createdAt: '2020-01-01T00:00:00Z',
};

const TEMPLATE_BODY = (pid: string, rating: number) => `### Plugin ID

${pid}

### 评分

${'★'.repeat(rating)} ${rating}

### 评论正文

very nice plugin`;

function makeNode(
  pid: string,
  rating: number,
  createdAt: string,
): MarketplaceReviewNode {
  return {
    title: `[${pid}] ok`,
    body: TEMPLATE_BODY(pid, rating),
    url: `https://gh/${pid}`,
    createdAt,
    author: AUTHOR,
    thumbsUp: 0,
  };
}

/** mock IPC 成功返回 nodes(available:true). */
function okNodes(nodes: MarketplaceReviewNode[]) {
  const data: FetchReviewsResult = { available: true, nodes };
  fetchReviewsMock.mockResolvedValue({ ok: true, data });
}

beforeEach(() => {
  _resetReviewsCacheForTest();
  sessionStorage.clear();
  fetchReviewsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetReviewsCacheForTest();
});

describe('fetchAllReviews — 正路径', () => {
  it('多 node → 按 pluginId 聚合,avg 算术平均', async () => {
    okNodes([
      makeNode('com.foo', 5, '2026-05-05T00:00:00Z'),
      makeNode('com.foo', 3, '2026-05-04T00:00:00Z'),
      makeNode('com.bar', 4, '2026-05-03T00:00:00Z'),
    ]);

    const map = await fetchAllReviews();
    expect(map.get('com.foo')?.count).toBe(2);
    expect(map.get('com.foo')?.avg).toBe(4); // (5+3)/2
    expect(map.get('com.bar')?.count).toBe(1);
    expect(map.get('com.bar')?.avg).toBe(4);
  });

  it('main 返回的 nodes 已是全量(分页是 main 职责)→ renderer 一次聚合', async () => {
    okNodes([
      makeNode('com.a', 5, '2026-05-05T00:00:00Z'),
      makeNode('com.a', 4, '2026-05-04T00:00:00Z'),
    ]);
    const map = await fetchAllReviews();
    expect(map.get('com.a')?.count).toBe(2);
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('1h 内重复调 → 命中 memory cache,不再 IPC', async () => {
    okNodes([makeNode('a', 5, 'now')]);
    await fetchAllReviews();
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh=true → 跳 cache 重 IPC', async () => {
    okNodes([makeNode('a', 5, 'now')]);
    await fetchAllReviews();
    await fetchAllReviews(true);
    expect(fetchReviewsMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchAllReviews — 无 token(main available:false)', () => {
  it('available:false + 无 cache → 抛 NO_TOKEN', async () => {
    fetchReviewsMock.mockResolvedValue({
      ok: true,
      data: { available: false, nodes: [] } satisfies FetchReviewsResult,
    });
    await expect(fetchAllReviews()).rejects.toThrow(/NO_TOKEN/);
  });

  it('available:false + 有 cache → 返 cache 不抛', async () => {
    okNodes([makeNode('a', 5, 'now')]);
    await fetchAllReviews();

    fetchReviewsMock.mockResolvedValue({
      ok: true,
      data: { available: false, nodes: [] } satisfies FetchReviewsResult,
    });
    const map = await fetchAllReviews(true);
    expect(map.get('a')?.count).toBe(1);
  });
});

describe('fetchAllReviews — 错误处理', () => {
  it('IPC ok:false + 无 cache → 抛 message', async () => {
    fetchReviewsMock.mockResolvedValue({
      ok: false,
      code: 'IPC_HANDLER_ERROR',
      message: 'HTTP 503',
    });
    await expect(fetchAllReviews()).rejects.toThrow(/HTTP 503/);
  });

  it('IPC reject + 有 cache → console.warn + 返 cache', async () => {
    okNodes([makeNode('a', 5, 'now')]);
    await fetchAllReviews();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchReviewsMock.mockRejectedValue(new Error('offline'));
    const map = await fetchAllReviews(true);

    expect(map.get('a')?.count).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to cache'),
      expect.any(Error),
    );
  });

  it('IPC reject + 无 cache → 透传抛', async () => {
    fetchReviewsMock.mockRejectedValue(new Error('offline'));
    await expect(fetchAllReviews()).rejects.toThrow(/offline/);
  });
});

describe('fetchAllReviews — sessionStorage hydrate', () => {
  it('memory 空但 sessionStorage 新鲜 → 直接命中,不 IPC', async () => {
    // M19:缓存样板统一为 createSessionCache 的 { fetchedAt, data } 形态。
    sessionStorage.setItem(
      'continuo:marketplace:reviews',
      JSON.stringify({
        fetchedAt: Date.now(),
        data: {
          a: { pluginId: 'a', count: 1, avg: 4, reviews: [] },
        },
      }),
    );

    const map = await fetchAllReviews();
    expect(map.get('a')?.avg).toBe(4);
    expect(fetchReviewsMock).not.toHaveBeenCalled();
  });
});
