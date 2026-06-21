// 安全 S4(codex 安全审计):marketplace reviews 的 GitHub token 曾经 renderer 直接用
// `import.meta.env.VITE_GITHUB_TOKEN` —— Vite 会把 VITE_* 内联进 renderer 产物,任何
// renderer 内插件 / 拿到打包应用的人都能提取(凭据泄漏 + 配额滥用)。
//
// 修复:token + GitHub fetch 移到 main 进程,token 走运行时 GITHUB_TOKEN env,绝不内联。
// 本规范锁定:(1) main 服务无 token → available:false(不发请求);(2) 有 token → 固定
// 查询 + 分页 + reactions 拍平成 thumbsUp;(3) renderer 源码不再含 VITE_GITHUB_TOKEN /
// 直连 GitHub GraphQL。
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchReviewNodes } from '../../../electron/main/services/marketplace-reviews.service';

const GQL = 'https://api.github.com/graphql';

function page(
  nodes: Array<{ pid: string; thumbs: number }>,
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      repository: {
        discussions: {
          nodes: nodes.map((n) => ({
            title: `[${n.pid}] ok`,
            body: 'b',
            url: `https://gh/${n.pid}`,
            createdAt: '2026-05-05T00:00:00Z',
            author: { login: 'a', avatarUrl: 'u' },
            reactions: { totalCount: n.thumbs },
          })),
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('安全 S4 — marketplace token 在 main(不内联 renderer)', () => {
  it('无 GITHUB_TOKEN → available:false 且不发任何网络请求(核心:不内联/不需密钥即降级)', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await fetchReviewNodes();
    expect(r).toEqual({ available: false, nodes: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('有 GITHUB_TOKEN → 带 Bearer 调固定 GraphQL,reactions.totalCount 拍平成 thumbsUp', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(page([{ pid: 'com.a', thumbs: 7 }], false, null)), {
          status: 200,
        }),
      );
    const r = await fetchReviewNodes();
    expect(r.available).toBe(true);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]?.thumbsUp).toBe(7);
    // 固定 endpoint + Bearer header
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(GQL);
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer ghp_secret',
    );
  });

  it('分页:hasNextPage=true → 用 endCursor 续拉,nodes 汇总返回', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page([{ pid: 'a', thumbs: 0 }], true, 'c1')), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page([{ pid: 'b', thumbs: 0 }], false, null)), {
          status: 200,
        }),
      );
    const r = await fetchReviewNodes();
    expect(r.nodes.map((n) => n.title)).toEqual(['[a] ok', '[b] ok']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body));
    expect(body2.variables.after).toBe('c1');
  });

  it('HTTP 非 2xx / GraphQL errors → 抛(safeHandle 包成 IpcFail,renderer 退守 cache)', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(fetchReviewNodes()).rejects.toThrow(/HTTP 503/);
  });

  it('renderer 源码 guard:reviews-fetcher 不再含 VITE_GITHUB_TOKEN / 直连 api.github.com', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../marketplace/reviews-fetcher.ts'),
      'utf8',
    );
    // 只允许出现在解释性注释里(import.meta.env 实际用法已移除)。
    expect(src).not.toContain('import.meta.env.VITE_GITHUB_TOKEN');
    expect(src).not.toContain('api.github.com');
    // 改走 IPC
    expect(src).toContain('coApi.marketplace.fetchReviews');
  });
});
