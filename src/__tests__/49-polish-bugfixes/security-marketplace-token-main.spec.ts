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

  // 边界(E298):endCursor 回传进下一页请求 body(after)。超 MAX_CURSOR_LEN(2048)的畸形/被篡改 cursor
  // → 停止翻页(cursor 不透明不能截断,否则损坏分页;已收到页仍可用),不把超大 cursor 发出。
  it('E298 超长 endCursor(> 2048)→ 停止翻页,不回传超大 cursor', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(page([{ pid: 'a', thumbs: 0 }], true, 'x'.repeat(2049))),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page([{ pid: 'b', thumbs: 0 }], false, null)), {
          status: 200,
        }),
      );
    const r = await fetchReviewNodes();
    // neutralize 敏感:去 endCursor 长度上限则用超大 cursor 续拉第二页(fetch 2 次,含 [b] ok)。
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.nodes.map((n) => n.title)).toEqual(['[a] ok']);
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

// 边界(E57,E2/E3 外部网络输入族):GitHub reviews 响应逐字段截断 + 节点总数上限 + 响应体预检。
describe('E57 · marketplace reviews 外部响应边界', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('超长 body → 截断到 16384', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const oversize = {
      data: {
        repository: {
          discussions: {
            nodes: [
              {
                title: '[com.a] ok',
                body: 'x'.repeat(20000),
                url: 'https://gh/a',
                createdAt: '2026-05-05T00:00:00Z',
                author: { login: 'a', avatarUrl: 'u' },
                reactions: { totalCount: 0 },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(oversize), { status: 200 }),
    );
    const r = await fetchReviewNodes();
    expect(r.nodes[0]?.body.length).toBe(16384);
  });

  it('节点总数超上限(2000)→ 停止累计/翻页', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const full = page(
      Array.from({ length: 100 }, (_, i) => ({ pid: `p${i}`, thumbs: 0 })),
      true, // 永远 hasNextPage,靠节点上限收敛
      'cursor',
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // 每次调用返回新 Response(Response body 只能读一次,翻页会多次 fetch)。
      .mockImplementation(
        () => new Response(JSON.stringify(full), { status: 200 }) as never,
      );
    const r = await fetchReviewNodes();
    expect(r.nodes).toHaveLength(2000); // 封顶,不无界累计
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(20); // 100/页 × 20 = 2000
  });

  it('响应体 Content-Length 超上限 → 抛(不 json 解析)', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(9 * 1024 * 1024) },
      }),
    );
    // E124:Content-Length 预检与流式字节闸统一抛 MARKETPLACE_RESPONSE_TOO_LARGE(与 fetcher 一致)。
    await expect(fetchReviewNodes()).rejects.toThrow(
      /MARKETPLACE_RESPONSE_TOO_LARGE/,
    );
  });

  // 边界(E65,E64 同款):Content-Length 仅 best-effort —— 缺省/伪造/chunked 时为 0 或小值
  // 放行预检,真正的字节闸是读 text 后按 text.length 硬拦。此处伪造一个小 content-length
  // 但响应体远超 8MiB,验证仍在 JSON.parse 之前抛 MARKETPLACE_RESPONSE_TOO_LARGE。
  it('E65 Content-Length 伪造为小值但响应体超 8MiB → 仍抛(text 字节闸,不 json 解析)', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const hugeBody = 'x'.repeat(9 * 1024 * 1024); // 非合法 JSON 也无妨:在 parse 前就被拦
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(hugeBody, {
        status: 200,
        headers: { 'content-length': '10' }, // 伪造:远小于真实体积,绕过 Content-Length 预检
      }),
    );
    await expect(fetchReviewNodes()).rejects.toThrow(
      /MARKETPLACE_RESPONSE_TOO_LARGE/,
    );
  });

  // 边界(E75,E73 错误串放大族):GraphQL errors 来自外部响应,数组条数/单条 message 长度不可控
  // (8MiB 内可塞大量错误)。经 capJoinedMessages 限条数 + 总长,防超长错误串经 safeHandle/renderer
  // 错误状态/通知链路放大。
  // 边界(E93):thumbsUp 须非负安全整数 —— 畸形 GraphQL 把点赞数设负数/小数 → canonicalize 0。
  it('E93 reactions.totalCount 负数/小数 → thumbsUp 归 0', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          page(
            [
              { pid: 'com.neg', thumbs: -5 },
              { pid: 'com.frac', thumbs: 1.5 },
              { pid: 'com.ok', thumbs: 3 },
            ],
            false,
            null,
          ),
        ),
        { status: 200 },
      ),
    );
    const r = await fetchReviewNodes();
    expect(r.nodes.map((n) => n.thumbsUp)).toEqual([0, 0, 3]);
  });

  it('E75 GraphQL errors 超量/超长 → 错误 message 有上限 + 截断标记', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const errors = Array.from({ length: 100 }, (_, i) => ({
      message: `err ${i} ${'z'.repeat(100)}`,
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors }), { status: 200 }),
    );
    const err = await fetchReviewNodes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message);
    expect(msg).toContain('GraphQL:');
    expect(msg.length).toBeLessThanOrEqual(2048 + 64); // 远小于未截断的 ~11.5K 字符
    expect(msg).toMatch(/truncated|more/);
  });

  // 边界(E165,E106 外部形态校验族):json.errors 来自外部响应,非数组(对象/字符串)此前经
  // `errors && errors.length > 0` 通过后 `.map` 抛 TypeError → 整次拉取失败退 stale。Array.isArray
  // 守卫后视为无结构化错误跳过(无 data → break → 空 nodes),不抛 TypeError。
  it('E165 errors 非数组({length:1})→ 不抛 TypeError,当无结构化错误', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: { length: 1 }, data: null }), {
        status: 200,
      }),
    );
    const r = await fetchReviewNodes();
    expect(r.nodes).toEqual([]); // 不抛 TypeError,优雅降级空列表
  });

  it('E165 errors 为字符串 → 不抛 TypeError', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: 'boom', data: null }), {
        status: 200,
      }),
    );
    const r = await fetchReviewNodes();
    expect(r.nodes).toEqual([]);
  });

  // 边界(E166,E165 兄弟/顶层形态):JSON.parse 顶层为 null/字符串/数组时,直接访问 json.errors
  //(尤其 null.errors)抛 TypeError。parse 后校验顶层为非 null 非数组对象,否则抛稳定
  // MARKETPLACE_RESPONSE_INVALID(可控 code,而非属性访问 TypeError)。
  it.each([
    ['null', 'null'],
    ['字符串', '"just a string"'],
    ['数组', '[1,2,3]'],
    ['数字', '42'],
  ])('E166 响应顶层为 %s → 抛 MARKETPLACE_RESPONSE_INVALID(非 TypeError)', async (_label, body) => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(body, { status: 200 }),
    );
    const err = await fetchReviewNodes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('MARKETPLACE_RESPONSE_INVALID');
    expect((err as Error).message).not.toMatch(/of null|not a function|undefined/i);
  });

  // 边界(E106):外部 GraphQL node 可能 null/非对象;toNode 直接读会抛 → 单坏节点让整次拉取失败。
  // 逐节点校验对象形态,坏节点跳过(其余 review 仍可用)。
  it('E106 nodes 含 null/非对象 → 跳过坏节点,不整次失败', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const resp = {
      data: {
        repository: {
          discussions: {
            nodes: [
              null,
              'not-an-object',
              {
                title: '[com.ok] x',
                body: 'b',
                url: 'https://gh/ok',
                createdAt: '2026-05-05T00:00:00Z',
                author: { login: 'a', avatarUrl: 'u' },
                reactions: { totalCount: 3 },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(resp), { status: 200 }),
    );
    const r = await fetchReviewNodes();
    expect(r.available).toBe(true);
    expect(r.nodes).toHaveLength(1); // 坏节点跳过,只保留合法节点
    expect(r.nodes[0]?.thumbsUp).toBe(3);
  });

  it('E106 pageInfo 畸形(null)→ 不抛,返回已收集节点', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    const resp = {
      data: {
        repository: {
          discussions: {
            nodes: [
              {
                title: 'x',
                body: 'b',
                url: 'u',
                createdAt: '2026-05-05T00:00:00Z',
                author: { login: 'a', avatarUrl: 'u' },
                reactions: { totalCount: 1 },
              },
            ],
            pageInfo: null, // 畸形:先判形态再读,不抛
          },
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(resp), { status: 200 }),
    );
    const r = await fetchReviewNodes();
    expect(r.available).toBe(true);
    expect(r.nodes).toHaveLength(1);
  });
});
