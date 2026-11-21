// @vitest-environment jsdom
// 安全 S4:token + GitHub fetch 已移到 main(IPC)。renderer 只 mock
// coApi.marketplace.fetchReviews(返 IpcResult<FetchReviewsResult>),验证 parse/aggregate
// /cache/降级逻辑。renderer 再无 VITE_GITHUB_TOKEN / 直连 fetch。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fetchReviewsMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/co-api', () => ({
  coApi: { marketplace: { fetchReviews: fetchReviewsMock } },
}));

import {
  _resetReviewsCacheForTest,
  MAX_REVIEW_NODES,
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

  it('聚合评分时不通过 reduce 二次扫描每组 reviews', async () => {
    okNodes([
      makeNode('com.foo', 5, '2026-05-05T00:00:00Z'),
      makeNode('com.foo', 3, '2026-05-04T00:00:00Z'),
    ]);
    const reduceSpy = vi.spyOn(Array.prototype, 'reduce');

    try {
      const map = await fetchAllReviews();
      expect(map.get('com.foo')?.avg).toBe(4);
      expect(reduceSpy).not.toHaveBeenCalled();
    } finally {
      reduceSpy.mockRestore();
    }
  });

  it('聚合分组 reviews 时按组计数预分配,不通过 group.reviews.push 扩容', async () => {
    okNodes([
      makeNode('com.foo', 5, '2026-05-05T00:00:00Z'),
      makeNode('com.foo', 3, '2026-05-04T00:00:00Z'),
      makeNode('com.bar', 4, '2026-05-03T00:00:00Z'),
    ]);

    const map = await fetchAllReviews();

    expect(map.get('com.foo')?.reviews.map((r) => r.rating)).toEqual([5, 3]);
    expect(map.get('com.bar')?.reviews.map((r) => r.rating)).toEqual([4]);
    const source = readFileSync(
      path.resolve(__dirname, '../../marketplace/reviews-fetcher.ts'),
      'utf8',
    );
    expect(source).not.toContain('group.reviews.push(');
  });

  it('写入 reviews cache 时不通过 Object.fromEntries 泛化转换 Map', async () => {
    okNodes([makeNode('com.foo', 5, '2026-05-05T00:00:00Z')]);
    const fromEntriesSpy = vi.spyOn(Object, 'fromEntries');

    try {
      const map = await fetchAllReviews();
      expect(map.get('com.foo')?.count).toBe(1);
      expect(fromEntriesSpy).not.toHaveBeenCalled();
    } finally {
      fromEntriesSpy.mockRestore();
    }
  });

  it('单条 review 聚合走快路径,不构建分组 Map', async () => {
    okNodes([makeNode('com.foo', 5, '2026-05-05T00:00:00Z')]);

    const map = await fetchAllReviews();
    const aggregate = map.get('com.foo');
    const source = readFileSync(
      path.resolve(__dirname, '../../marketplace/reviews-fetcher.ts'),
      'utf8',
    );
    const aggregateBody = source.slice(
      source.indexOf('function aggregate('),
      source.indexOf('/** 测试用:重置 cache. */'),
    );

    expect(aggregate?.count).toBe(1);
    expect(aggregate?.avg).toBe(5);
    expect(aggregate?.reviews).toHaveLength(1);
    expect(aggregateBody.indexOf('reviews.length === 1')).toBeLessThan(
      aggregateBody.indexOf('const groups = new Map'),
    );
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

  it('memory cache 命中时不通过 Object.entries 生成中间数组', async () => {
    okNodes([makeNode('a', 5, 'now')]);
    await fetchAllReviews();

    const entriesSpy = vi.spyOn(Object, 'entries');
    try {
      const map = await fetchAllReviews();
      expect(map.get('a')?.count).toBe(1);
      expect(entriesSpy).not.toHaveBeenCalled();
    } finally {
      entriesSpy.mockRestore();
    }
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
          // E94:count 须与 reviews.length 一致(aggregate 不变量),fixture 给完整合法 review。
          a: {
            pluginId: 'a',
            count: 1,
            avg: 4,
            reviews: [
              {
                pluginId: 'a',
                rating: 4,
                body: 'b',
                url: 'https://gh/a',
                createdAt: '2026-05-05T00:00:00Z',
                thumbsUp: 0,
                author: {
                  handle: 'x',
                  avatarUrl: 'https://x/a',
                  createdAt: '2020-01-01T00:00:00Z',
                },
              },
            ],
          },
        },
      }),
    );

    const map = await fetchAllReviews();
    expect(map.get('a')?.avg).toBe(4);
    expect(fetchReviewsMock).not.toHaveBeenCalled();
  });
});

// 边界(E3):reviews 缓存此前只校验「是对象」→ 畸形/旧缓存被当新鲜返回,Marketplace 渲染时
// avg.toFixed() / reviews.length 崩面板。深度校验:非法缓存当 cache miss 重拉。
describe('边界(E3) — 畸形 reviews 缓存深度校验', () => {
  it('缓存 avg 非数值 + reviews 非数组 → 当 cache miss,走 IPC 重建', async () => {
    sessionStorage.setItem(
      'continuo:marketplace:reviews',
      JSON.stringify({
        fetchedAt: Date.now(),
        data: { p: { pluginId: 'p', count: 1, avg: 'bad', reviews: {} } },
      }),
    );
    okNodes([makeNode('com.foo', 5, '2026-05-05T00:00:00Z')]);
    const map = await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1); // 畸形缓存弃用 → 走 IPC
    expect(map.get('com.foo')?.avg).toBe(5);
  });

  it('缓存某条 review 字段畸形(rating 非数值)→ 当 cache miss', async () => {
    sessionStorage.setItem(
      'continuo:marketplace:reviews',
      JSON.stringify({
        fetchedAt: Date.now(),
        data: {
          p: {
            pluginId: 'p',
            count: 1,
            avg: 5,
            reviews: [{ pluginId: 'p', rating: 'five', body: 'b' }],
          },
        },
      }),
    );
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    const map = await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
    expect(map.get('com.bar')?.avg).toBe(4);
  });

  it('合法完整缓存(含 review 全字段)→ 深度校验通过,命中不 IPC', async () => {
    sessionStorage.setItem(
      'continuo:marketplace:reviews',
      JSON.stringify({
        fetchedAt: Date.now(),
        data: {
          p: {
            pluginId: 'p',
            count: 1,
            avg: 5,
            reviews: [
              {
                pluginId: 'p',
                rating: 5,
                body: 'good',
                url: 'https://gh/p',
                createdAt: '2026-05-05T00:00:00Z',
                thumbsUp: 2,
                author: {
                  handle: 'a',
                  avatarUrl: 'https://x/a',
                  createdAt: '2020-01-01T00:00:00Z',
                },
              },
            ],
          },
        },
      }),
    );
    const map = await fetchAllReviews();
    expect(fetchReviewsMock).not.toHaveBeenCalled(); // 合法缓存命中
    expect(map.get('p')?.reviews.length).toBe(1);
  });

  // 边界(E93):缓存 review 的 thumbsUp 须非负安全整数 —— 负数/小数(脏缓存)当 cache miss。
  it('E93 缓存 review thumbsUp 负数/小数 → 当 cache miss(深度校验)', async () => {
    sessionStorage.setItem(
      'continuo:marketplace:reviews',
      JSON.stringify({
        fetchedAt: Date.now(),
        data: {
          p: {
            pluginId: 'p',
            count: 1,
            avg: 5,
            reviews: [
              {
                pluginId: 'p',
                rating: 5,
                body: 'good',
                url: 'https://gh/p',
                createdAt: '2026-05-05T00:00:00Z',
                thumbsUp: -3, // 非法:负点赞数
                author: {
                  handle: 'a',
                  avatarUrl: 'https://x/a',
                  createdAt: '2020-01-01T00:00:00Z',
                },
              },
            ],
          },
        },
      }),
    );
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    const map = await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1); // 脏缓存弃用 → 走 IPC
    expect(map.get('com.bar')?.avg).toBe(4);
  });
});

// 边界(E94):aggregate 业务值域校验 —— rating∈1..5 整数、count 非负安全整数且 ===reviews.length、
// avg∈1..5。脏缓存(999 stars / 负数 / count 不一致)当 cache miss,防畸形渲染 + 排序污染。
describe('边界(E94) — reviews 缓存业务值域校验', () => {
  const validReview = {
    pluginId: 'p',
    rating: 5,
    body: 'g',
    url: 'https://gh/p',
    createdAt: '2026-05-05T00:00:00Z',
    thumbsUp: 1,
    author: {
      handle: 'a',
      avatarUrl: 'https://x/a',
      createdAt: '2020-01-01T00:00:00Z',
    },
  };
  function setCache(agg: Record<string, unknown>): void {
    sessionStorage.setItem(
      'continuo:marketplace:reviews',
      JSON.stringify({ fetchedAt: Date.now(), data: { p: agg } }),
    );
  }

  it('E94 rating 超 1..5(999)→ cache miss', async () => {
    setCache({
      pluginId: 'p',
      count: 1,
      avg: 5,
      reviews: [{ ...validReview, rating: 999 }],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('E94 count 与 reviews.length 不一致 → cache miss', async () => {
    setCache({ pluginId: 'p', count: 5, avg: 5, reviews: [validReview] });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('E94 avg 超 1..5(9)→ cache miss', async () => {
    setCache({ pluginId: 'p', count: 1, avg: 9, reviews: [validReview] });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('E94 合法值域 aggregate → 命中不 IPC', async () => {
    setCache({ pluginId: 'p', count: 1, avg: 5, reviews: [validReview] });
    const map = await fetchAllReviews();
    expect(fetchReviewsMock).not.toHaveBeenCalled();
    expect(map.get('p')?.count).toBe(1);
  });

  // 边界(E109,E108 同族):review.url / author.avatarUrl 渲染为 <a href>/<img src>,须 http/https。
  // 篡改缓存放 javascript:/file: → 该 review 非法当 cache miss。
  it('E109 缓存 review.url 危险协议(javascript:)→ cache miss', async () => {
    setCache({
      pluginId: 'p',
      count: 1,
      avg: 5,
      reviews: [{ ...validReview, url: 'javascript:alert(1)' }],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1); // 脏缓存弃用 → 走 IPC
  });

  it('E109 缓存 avatarUrl 危险协议(file:)→ cache miss', async () => {
    setCache({
      pluginId: 'p',
      count: 1,
      avg: 5,
      reviews: [
        { ...validReview, author: { ...validReview.author, avatarUrl: 'file:///x' } },
      ],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  // 边界(E111,E57 写端逐字段截断的读端对偶):缓存深度校验须镜像 main 的字段长度 + 数量上限。
  // 篡改缓存塞超长 body/handle/url 或超多 reviews → 非法当 cache miss(防 DOM 渲染放大)。
  it('E111 缓存 body 超 16384 → cache miss', async () => {
    setCache({
      pluginId: 'p',
      count: 1,
      avg: 5,
      reviews: [{ ...validReview, body: 'x'.repeat(16385) }],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('E111 缓存 author.handle 超 512 → cache miss', async () => {
    setCache({
      pluginId: 'p',
      count: 1,
      avg: 5,
      reviews: [
        { ...validReview, author: { ...validReview.author, handle: 'h'.repeat(513) } },
      ],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('E111 缓存 url 超 2048 → cache miss', async () => {
    setCache({
      pluginId: 'p',
      count: 1,
      avg: 5,
      reviews: [{ ...validReview, url: 'https://gh/' + 'x'.repeat(2048) }],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('E111 缓存单插件 reviews 超 2000 条 → cache miss', async () => {
    const many = Array.from({ length: 2001 }, () => validReview);
    setCache({ pluginId: 'p', count: 2001, avg: 5, reviews: many });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  // 边界(E112):author.handle 拼进 github.com 个人主页链接 + maintainer 判断,须合法 GitHub login。
  // 篡改缓存放 ../user / a/b → 非法 review 当 cache miss。
  it('E112 缓存 handle 非 GitHub login(../user)→ cache miss', async () => {
    setCache({
      pluginId: 'p',
      count: 1,
      avg: 5,
      reviews: [
        { ...validReview, author: { ...validReview.author, handle: '../user' } },
      ],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  // 边界(E113):pluginId 须合法形态 + aggregate key/pluginId/review.pluginId 三者一致。
  it('E113 缓存 review.pluginId 畸形形态(../x)→ cache miss', async () => {
    setCache({
      pluginId: 'p',
      count: 1,
      avg: 5,
      reviews: [{ ...validReview, pluginId: '../x' }],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  it('E113 缓存 record key 与 aggregate.pluginId 不一致 → cache miss', async () => {
    // setCache 的 key 固定 'p',但 aggregate.pluginId 设为 'q'(合法形态)→ key≠pluginId
    setCache({
      pluginId: 'q',
      count: 1,
      avg: 5,
      reviews: [{ ...validReview, pluginId: 'q' }],
    });
    okNodes([makeNode('com.bar', 4, '2026-05-03T00:00:00Z')]);
    await fetchAllReviews();
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
  });

  // 边界(E243,E215 读端独立校验族):res.data.nodes 来自 IPC,renderer 独立守卫数组形态 + 数量上限。
  it('E243 nodes 非数组(畸形 IPC)→ 稳定返回空 Map,不抛', async () => {
    fetchReviewsMock.mockResolvedValue({
      ok: true,
      data: { available: true, nodes: 'not-an-array' } as unknown as FetchReviewsResult,
    });
    const r = await fetchAllReviews();
    expect(r.size).toBe(0); // 不抛,空结果
  });

  it('E243 空/全无效 reviews 复用稳定空 Map', async () => {
    fetchReviewsMock.mockResolvedValue({
      ok: true,
      data: { available: true, nodes: [] } satisfies FetchReviewsResult,
    });
    const empty = await fetchAllReviews(true);
    expect(empty.size).toBe(0);

    fetchReviewsMock.mockResolvedValueOnce({
      ok: true,
      data: { available: true, nodes: 'not-an-array' } as unknown as FetchReviewsResult,
    });
    await expect(fetchAllReviews(true)).resolves.toBe(empty);

    fetchReviewsMock.mockResolvedValueOnce({
      ok: true,
      data: { available: true, nodes: [null, 'bad'] } as unknown as FetchReviewsResult,
    });
    await expect(fetchAllReviews(true)).resolves.toBe(empty);

    await expect(fetchAllReviews()).resolves.toBe(empty);
  });

  it('E243 nodes 超 MAX_REVIEW_NODES → 截断到上限(只解析前 N 个)', async () => {
    // 造 MAX_REVIEW_NODES+5 个同 pid 的合法 node;截断后 aggregate count 应为 MAX_REVIEW_NODES。
    const many = Array.from({ length: MAX_REVIEW_NODES + 5 }, (_, i) =>
      makeNode('com.bulk', 5, `2026-05-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`),
    );
    okNodes(many);
    const r = await fetchAllReviews();
    expect(r.get('com.bulk')?.count).toBe(MAX_REVIEW_NODES); // 截断,非 +5
  });

  it('E243 nodes 超上限时按索引有界遍历,不 slice 复制超大 IPC 数组', async () => {
    const many = Array.from({ length: MAX_REVIEW_NODES + 5 }, (_, i) =>
      makeNode('com.bulk', 5, `2026-05-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`),
    );
    okNodes(many);
    const sliceSpy = vi.spyOn(many, 'slice');

    try {
      const r = await fetchAllReviews();

      expect(r.get('com.bulk')?.count).toBe(MAX_REVIEW_NODES);
      expect(sliceSpy).not.toHaveBeenCalled();
    } finally {
      sliceSpy.mockRestore();
    }
  });

  it('E243 nodes 解析到 reviews 时预分配上限数组,不 push 扩容', async () => {
    okNodes([
      makeNode('com.bulk', 5, '2026-05-05T00:00:00Z'),
      makeNode('com.bulk', 4, '2026-05-04T00:00:00Z'),
    ]);

    const r = await fetchAllReviews();

    expect(r.get('com.bulk')?.count).toBe(2);
    expect(fetchAllReviews.toString()).not.toContain('reviews.push(');
  });
});
