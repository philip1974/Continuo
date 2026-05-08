// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => globalThis.fetch,
  getCachedClipboard: () => ({
    readText: () => Promise.resolve(''),
    writeText: () => Promise.resolve(),
  }),
  sandboxSweep: () => {},
}));

import {
  _resetReviewsCacheForTest,
  fetchAllReviews,
} from '../../marketplace/reviews-fetcher';

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

interface PageNode {
  title: string;
  body: string;
  url: string;
  createdAt: string;
  author: typeof AUTHOR | null;
  reactions: { totalCount: number };
}

function graphqlPage(
  nodes: PageNode[],
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      repository: {
        discussions: {
          nodes,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

function makeNode(pid: string, rating: number, createdAt: string): PageNode {
  return {
    title: `[${pid}] ok`,
    body: TEMPLATE_BODY(pid, rating),
    url: `https://gh/${pid}`,
    createdAt,
    author: AUTHOR,
    reactions: { totalCount: 0 },
  };
}

const STUB_TOKEN = 'ghp_test';

beforeEach(() => {
  _resetReviewsCacheForTest();
  sessionStorage.clear();
  vi.stubEnv('VITE_GITHUB_TOKEN', STUB_TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetReviewsCacheForTest();
});

function mockJson(payload: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
      }),
  );
}

describe('fetchAllReviews — 正路径', () => {
  it('单页 → 按 pluginId 聚合,avg 算术平均', async () => {
    mockJson(
      graphqlPage(
        [
          makeNode('com.foo', 5, '2026-05-05T00:00:00Z'),
          makeNode('com.foo', 3, '2026-05-04T00:00:00Z'),
          makeNode('com.bar', 4, '2026-05-03T00:00:00Z'),
        ],
        false,
        null,
      ),
    );

    const map = await fetchAllReviews();
    expect(map.get('com.foo')?.count).toBe(2);
    expect(map.get('com.foo')?.avg).toBe(4); // (5+3)/2
    expect(map.get('com.bar')?.count).toBe(1);
    expect(map.get('com.bar')?.avg).toBe(4);
  });

  it('翻页:hasNextPage=true → 用 endCursor 继续', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            graphqlPage(
              [makeNode('com.a', 5, '2026-05-05T00:00:00Z')],
              true,
              'cursor-1',
            ),
          ),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            graphqlPage(
              [makeNode('com.a', 4, '2026-05-04T00:00:00Z')],
              false,
              null,
            ),
          ),
          { status: 200 },
        ),
      );

    const map = await fetchAllReviews();
    expect(map.get('com.a')?.count).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const secondCallBody = JSON.parse(
      String(fetchSpy.mock.calls[1]![1]!.body),
    );
    expect(secondCallBody.variables.after).toBe('cursor-1');
  });

  it('1h 内重复调 → 命中 memory cache,不再 fetch', async () => {
    const f = mockJson(graphqlPage([makeNode('a', 5, 'now')], false, null));
    await fetchAllReviews();
    await fetchAllReviews();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh=true → 跳 cache 重 fetch', async () => {
    const f = mockJson(graphqlPage([makeNode('a', 5, 'now')], false, null));
    await fetchAllReviews();
    await fetchAllReviews(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('fetchAllReviews — token 缺失', () => {
  it('无 token + 无 cache → 抛 NO_TOKEN', async () => {
    vi.stubEnv('VITE_GITHUB_TOKEN', '');
    await expect(fetchAllReviews()).rejects.toThrow(/NO_TOKEN/);
  });

  it('无 token + 有 cache → 返 cache 不抛', async () => {
    // 先有 token 填一次 cache
    mockJson(graphqlPage([makeNode('a', 5, 'now')], false, null));
    await fetchAllReviews();

    // 切断 token + cache 仍在
    vi.stubEnv('VITE_GITHUB_TOKEN', '');
    const map = await fetchAllReviews();
    expect(map.get('a')?.count).toBe(1);
  });
});

describe('fetchAllReviews — 错误处理', () => {
  it('GraphQL errors 非空 → 抛', async () => {
    mockJson({
      errors: [{ message: 'rate limited' }, { message: 'auth' }],
    });
    await expect(fetchAllReviews()).rejects.toThrow(
      /GraphQL: rate limited; auth/,
    );
  });

  it('HTTP 非 2xx → 抛', async () => {
    mockJson({}, 503);
    await expect(fetchAllReviews()).rejects.toThrow(/HTTP 503/);
  });

  it('网络失败 + 有 cache → console.warn + 返 cache', async () => {
    mockJson(graphqlPage([makeNode('a', 5, 'now')], false, null));
    await fetchAllReviews();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const map = await fetchAllReviews(true);

    expect(map.get('a')?.count).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to cache'),
      expect.any(Error),
    );
  });

  it('网络失败 + 无 cache → 透传抛', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(fetchAllReviews()).rejects.toThrow(/offline/);
  });
});

describe('fetchAllReviews — sessionStorage hydrate', () => {
  it('memory 空但 sessionStorage 新鲜 → 直接命中,不 fetch', async () => {
    sessionStorage.setItem(
      'continuo:marketplace:reviews',
      JSON.stringify({
        fetchedAt: Date.now(),
        byPid: {
          'a': {
            pluginId: 'a',
            count: 1,
            avg: 4,
            reviews: [],
          },
        },
      }),
    );

    const f = mockJson({});
    const map = await fetchAllReviews();
    expect(map.get('a')?.avg).toBe(4);
    expect(f).not.toHaveBeenCalled();
  });
});
