import { describe, it, expect, vi } from 'vitest';
import { parseReview } from '../../marketplace/reviews-parser';
import {
  isValidAggregateRecord,
  REVIEW_URL_MAX,
} from '../../marketplace/reviews-types';

// 合法最小 aggregate(count=0/reviews=[]/avg=1,key=pluginId)。
function validAgg(key: string) {
  return { pluginId: key, count: 0, avg: 1, reviews: [] };
}

// 合法 aggregate 含 n 条合法 review(用于 E210 全局累计 reviews 上限)。
function aggWithReviews(key: string, n: number) {
  const reviews = Array.from({ length: n }, () => ({
    pluginId: key,
    rating: 5,
    body: 'x',
    url: 'https://x',
    createdAt: '2026',
    thumbsUp: 0,
    author: { handle: 'a', avatarUrl: 'https://x', createdAt: '2020' },
  }));
  return { pluginId: key, count: n, avg: 5, reviews };
}

const AUTHOR = { login: 'alice', avatarUrl: 'https://avatars.example/alice' };

const TEMPLATE_BODY = `### Plugin ID

com.example.foo

### 评分

★★★★★ 5

### 评论正文

很好用,推荐。

### Continuo 版本(可选)

0.1.0

### Plugin 版本(可选)

0.2.0`;

describe('parseReview — 模板正路径', () => {
  it('完整模板 → 全字段抽出', () => {
    const r = parseReview({
      title: '[com.example.foo] great',
      body: TEMPLATE_BODY,
      url: 'https://x',
      createdAt: '2026-05-05T00:00:00Z',
      author: AUTHOR,
    });
    expect(r).not.toBeNull();
    expect(r!.pluginId).toBe('com.example.foo');
    expect(r!.rating).toBe(5);
    expect(r!.body).toBe('很好用,推荐。');
    expect(r!.author.handle).toBe('alice');
    expect(r!.continuoVersion).toBe('0.1.0');
    expect(r!.pluginVersion).toBe('0.2.0');
  });
});

// 边界(E250,E243 续):parseReview 入参可为畸形(fetchAllReviews 只校验 nodes 是数组,元素仍可
// null/数字/字符串)。非对象元素须返 null 跳过,不抛 TypeError(否则单个坏节点让整个 reviews 加载失败)。
describe('parseReview — E250 畸形元素跳过(不抛)', () => {
  it.each([null, undefined, 42, 'a string', true, []])(
    '非对象/畸形 raw(%o)→ 返 null,不抛',
    (bad) => {
      expect(() => parseReview(bad as unknown)).not.toThrow();
      expect(parseReview(bad as unknown)).toBeNull();
    },
  );

  it('createdAt 非字符串 → 返 null(与 cache-read isValidReview 对齐)', () => {
    expect(
      parseReview({
        title: '[com.example.foo] x',
        body: TEMPLATE_BODY,
        url: 'https://x',
        createdAt: 123 as unknown as string,
        author: AUTHOR,
      }),
    ).toBeNull();
  });

  // 边界(E253):author.createdAt / 版本字段 fresh 路径补类型+长度校验,与 cache-read 对齐。
  it('E253 author.createdAt 非 string/超长 → 默认 epoch(不写脏值致 new Date NaN)', () => {
    const r = parseReview({
      title: '[com.example.foo] x',
      body: TEMPLATE_BODY,
      url: 'https://x',
      createdAt: '2026-05-05T00:00:00Z',
      author: {
        login: 'alice',
        avatarUrl: 'https://x/a',
        createdAt: { evil: 1 } as unknown as string, // 非 string
      },
    });
    expect(r).not.toBeNull();
    expect(r!.author.createdAt).toBe('1970-01-01T00:00:00Z');
    expect(Number.isNaN(new Date(r!.author.createdAt).getTime())).toBe(false);
  });

  it('E253 顶层 createdAt 超长(>512)→ 返 null', () => {
    expect(
      parseReview({
        title: '[com.example.foo] x',
        body: TEMPLATE_BODY,
        url: 'https://x',
        createdAt: 'x'.repeat(513),
        author: AUTHOR,
      }),
    ).toBeNull();
  });

  it('E253 版本 section 超长(>128)→ undefined', () => {
    const longVer = 'v'.repeat(200);
    const r = parseReview({
      title: '[com.example.foo] x',
      body: `### Plugin ID\ncom.example.foo\n### 评分\n★★★★★ 5\n### 评论正文\nok\n### Continuo 版本(可选)\n${longVer}`,
      url: 'https://x',
      createdAt: '2026-05-05T00:00:00Z',
      author: AUTHOR,
    });
    expect(r).not.toBeNull();
    expect(r!.continuoVersion).toBeUndefined();
  });
});

// 边界(E143,E109 fresh-fetch 对偶):parseReview(fresh GraphQL 路径)须对 url/avatarUrl 做
// http/https 白名单(与 cache-read isValidReview 同款),否则首次拉取可绕过白名单渲染危险外链/src。
describe('parseReview — E143 url/avatarUrl scheme 白名单(fresh path)', () => {
  const base = {
    title: '[com.example.foo] x',
    body: TEMPLATE_BODY,
    createdAt: '2026-05-05T00:00:00Z',
  };
  it('危险协议 url(javascript:)→ null', () => {
    expect(
      parseReview({
        ...base,
        url: 'javascript:alert(1)',
        author: { login: 'a', avatarUrl: 'https://x/a' },
      }),
    ).toBeNull();
  });
  it('危险协议 avatarUrl(file:)→ null', () => {
    expect(
      parseReview({
        ...base,
        url: 'https://gh/p',
        author: { login: 'a', avatarUrl: 'file:///etc/passwd' },
      }),
    ).toBeNull();
  });
  it('合法 https url + avatarUrl → 解析成功', () => {
    expect(
      parseReview({
        ...base,
        url: 'https://gh/p',
        author: { login: 'a', avatarUrl: 'https://x/a' },
      }),
    ).not.toBeNull();
  });

  // 边界(E294,E253/E250 fresh↔cache-read 长度对偶):合法 scheme 但超 REVIEW_URL_MAX 的 url/avatarUrl
  // → null(与 cache-read isValidReview isStrMax 同款)。
  it('E294 超长 https url(> REVIEW_URL_MAX)→ null', () => {
    expect(
      parseReview({
        ...base,
        url: 'https://x/' + 'a'.repeat(REVIEW_URL_MAX),
        author: { login: 'a', avatarUrl: 'https://x/a' },
      }),
    ).toBeNull();
  });
  it('E294 超长 https avatarUrl(> REVIEW_URL_MAX)→ null', () => {
    expect(
      parseReview({
        ...base,
        url: 'https://gh/p',
        author: { login: 'a', avatarUrl: 'https://x/' + 'a'.repeat(REVIEW_URL_MAX) },
      }),
    ).toBeNull();
  });
  it('E294 恰好 REVIEW_URL_MAX 长的合法 url → 解析成功(边界包含)', () => {
    const url = 'https://x/' + 'a'.repeat(REVIEW_URL_MAX - 'https://x/'.length);
    expect(url.length).toBe(REVIEW_URL_MAX);
    expect(
      parseReview({
        ...base,
        url,
        author: { login: 'a', avatarUrl: 'https://x/a' },
      }),
    ).not.toBeNull();
  });
});

// 边界(E144,E93 fresh-fetch 对偶):thumbsUp 须非负安全整数,防畸形值进 helpful 排序(NaN/错序)。
describe('parseReview — E144 thumbsUp 非负安全整数(fresh path)', () => {
  const mk = (thumbsUp: unknown) =>
    parseReview({
      title: '[com.example.foo] x',
      body: TEMPLATE_BODY,
      url: 'https://gh/p',
      createdAt: '2026-05-05T00:00:00Z',
      author: { login: 'a', avatarUrl: 'https://x/a' },
      thumbsUp: thumbsUp as never,
    });

  it('负数/小数/非数/超安全整数 → 归 0', () => {
    expect(mk(-5)?.thumbsUp).toBe(0);
    expect(mk(2.5)?.thumbsUp).toBe(0);
    expect(mk('99' as never)?.thumbsUp).toBe(0);
    expect(mk(Number.MAX_SAFE_INTEGER + 2)?.thumbsUp).toBe(0);
    expect(mk(Infinity)?.thumbsUp).toBe(0);
  });

  it('合法非负安全整数 → 保留', () => {
    expect(mk(7)?.thumbsUp).toBe(7);
    expect(mk(0)?.thumbsUp).toBe(0);
    expect(mk(undefined)?.thumbsUp).toBe(0); // 缺省 → 0
  });
});

describe('parseReview — E112 author handle 须合法 GitHub login', () => {
  const mk = (login: string) =>
    parseReview({
      title: '[com.example.foo] x',
      body: TEMPLATE_BODY,
      url: 'https://x',
      createdAt: '2026-05-05T00:00:00Z',
      author: { login, avatarUrl: 'https://avatars.example/x' },
    });

  it('合法 login(alice / a / philip1974)→ 解析成功', () => {
    expect(mk('alice')).not.toBeNull();
    expect(mk('a')).not.toBeNull();
    expect(mk('philip1974')).not.toBeNull();
  });

  it('畸形 login(../user, a/b, x?tab=, 首尾/连续-, 超39)→ null 跳过', () => {
    for (const bad of [
      '../user',
      'a/b',
      'x?tab=repositories',
      '-foo',
      'foo-',
      'a--b',
      'has space',
      'x'.repeat(40),
    ]) {
      expect(mk(bad)).toBeNull();
    }
  });
});

describe('parseReview — E113 body section pluginId 须合法形态', () => {
  const bodyWithPid = (pid: string) => `### Plugin ID

${pid}

### 评分

★★★★★ 5

### 评论正文

ok`;

  it('合法 body pluginId(com.example.foo)→ 成功', () => {
    const r = parseReview({
      title: 'no brackets here',
      body: bodyWithPid('com.example.foo'),
      url: 'https://x',
      createdAt: '2026-05-05T00:00:00Z',
      author: AUTHOR,
    });
    expect(r).not.toBeNull();
    expect(r!.pluginId).toBe('com.example.foo');
  });

  it('畸形 body pluginId(../bad, a/b, 空格, 大写)→ null 跳过', () => {
    for (const bad of ['../bad', 'a/b', 'has space', 'UpperCase', '..', '.']) {
      const r = parseReview({
        title: 'no brackets here',
        body: bodyWithPid(bad),
        url: 'https://x',
        createdAt: '2026-05-05T00:00:00Z',
        author: AUTHOR,
      });
      expect(r).toBeNull();
    }
  });
});

describe('parseReview — E57 防御性长度上限', () => {
  it('非字符串 body/title → null', () => {
    expect(
      parseReview({
        title: 123 as never,
        body: 'x',
        url: 'u',
        createdAt: 'now',
        author: AUTHOR,
      }),
    ).toBeNull();
    expect(
      parseReview({
        title: '[a] x',
        body: {} as never,
        url: 'u',
        createdAt: 'now',
        author: AUTHOR,
      }),
    ).toBeNull();
  });

  it('超长 评论正文 section(>16384)→ body 截断到 ≤16384(不在 split 处放大)', () => {
    // 评论正文 内容灌到 40000 字符;safeBody 截断到 16384 后,section 抽出的 body 受限。
    const hugeReview =
      `### Plugin ID\n\ncom.example.foo\n\n### 评分\n\n★★★★★ 5\n\n### 评论正文\n\n` +
      'y'.repeat(40000);
    const r = parseReview({
      title: '[com.example.foo] big',
      body: hugeReview,
      url: 'https://x',
      createdAt: '2026-05-05T00:00:00Z',
      author: AUTHOR,
    });
    expect(r).not.toBeNull();
    expect(r!.pluginId).toBe('com.example.foo');
    expect(r!.rating).toBe(5);
    expect(r!.body.length).toBeLessThanOrEqual(16384); // 中和(去截断)→ 40000 > 16384 失败
  });
});

describe('parseReview — pluginId 容错', () => {
  it('body 缺 Plugin ID section → fallback title 第一对方括号', () => {
    const body = `### 评分\n★★★ 3\n### 评论正文\nmid`;
    const r = parseReview({
      title: '[com.bar] not bad',
      body,
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.pluginId).toBe('com.bar');
  });

  it('title 也缺 → null', () => {
    const r = parseReview({
      title: 'no brackets here',
      body: '### 评分\n5\n### 评论正文\ntext',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r).toBeNull();
  });
});

describe('parseReview — rating 解析', () => {
  it('"★★★★★ 5" → 5', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n★★★★★ 5\n### 评论正文\nx',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.rating).toBe(5);
  });

  it('"★ 1" → 1', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n★ 1\n### 评论正文\nx',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.rating).toBe(1);
  });

  it('纯数字 "3/5" → 3', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n3/5\n### 评论正文\nx',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.rating).toBe(3);
  });

  it('rating section 缺 → null(不计)', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评论正文\nx',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r).toBeNull();
  });

  it('rating 超界(6 / 0)→ null', () => {
    const r1 = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n6\n### 评论正文\nx',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r1).toBeNull();
    const r2 = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n0\n### 评论正文\nx',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r2).toBeNull();
  });
});

describe('parseReview — 边界', () => {
  it('author null → null(GitHub 删账号了)', () => {
    const r = parseReview({
      title: '[a]',
      body: TEMPLATE_BODY.replace('com.example.foo', 'a'),
      url: 'https://x',
      createdAt: 'now',
      author: null,
    });
    expect(r).toBeNull();
  });

  it('正文段空白 → null', () => {
    const r = parseReview({
      title: '[a]',
      body: '### Plugin ID\na\n### 评分\n3\n### 评论正文\n   \n',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r).toBeNull();
  });

  it('title 抽出 pluginId 校 [a-z0-9._-]+ 字符集', () => {
    const r = parseReview({
      title: '[com.foo-bar_baz.1] ok',
      body: '### 评分\n3\n### 评论正文\nx',
      url: 'https://x',
      createdAt: 'now',
      author: AUTHOR,
    });
    expect(r?.pluginId).toBe('com.foo-bar_baz.1');
  });
});

// 边界(E197,E176/E189/E192 有界迭代族):isValidAggregateRecord 单次 for...in 惰性遍历,边计数边校验,
// 不先 Object.keys/Object.entries 把篡改缓存的所有 key 全量物化(两次)再判 MAX_AGGREGATE_KEYS 上限。
describe('E197 · isValidAggregateRecord 有界单次遍历', () => {
  it('不调用 Object.keys / Object.entries(单次 for...in,不全量物化)', () => {
    const keysSpy = vi.spyOn(Object, 'keys');
    const entriesSpy = vi.spyOn(Object, 'entries');
    const rec = { a: validAgg('a'), b: validAgg('b') };
    expect(isValidAggregateRecord(rec)).toBe(true);
    expect(keysSpy).not.toHaveBeenCalled();
    expect(entriesSpy).not.toHaveBeenCalled();
    keysSpy.mockRestore();
    entriesSpy.mockRestore();
  });

  it('key 数超 MAX_AGGREGATE_KEYS(全合法)→ false(计数超限立即返回)', () => {
    const big: Record<string, ReturnType<typeof validAgg>> = {};
    for (let i = 0; i <= 2000; i++) big[`p${i}`] = validAgg(`p${i}`); // 2001 个 > 2000
    expect(isValidAggregateRecord(big)).toBe(false);
  });

  it('恰好 MAX_AGGREGATE_KEYS(2000 全合法)→ true(边界回归)', () => {
    const exact: Record<string, ReturnType<typeof validAgg>> = {};
    for (let i = 0; i < 2000; i++) exact[`p${i}`] = validAgg(`p${i}`);
    expect(isValidAggregateRecord(exact)).toBe(true);
  });

  it('key 与 aggregate.pluginId 不一致 → false(E113 回归)', () => {
    expect(isValidAggregateRecord({ a: validAgg('b') })).toBe(false);
  });

  it('某 value 非法 aggregate(avg 越界)→ false', () => {
    expect(
      isValidAggregateRecord({ a: { pluginId: 'a', count: 0, avg: 9, reviews: [] } }),
    ).toBe(false);
  });

  it('空 record {} → true;非对象 / 数组 → false', () => {
    expect(isValidAggregateRecord({})).toBe(true);
    expect(isValidAggregateRecord([])).toBe(false);
    expect(isValidAggregateRecord(null)).toBe(false);
    expect(isValidAggregateRecord('x')).toBe(false);
  });
});

// 边界(E210):全局累计 reviews 上限(对齐 main MAX_TOTAL_NODES=2000)。只限 key 数 + 单插件 reviews 数
// 时,很多 plugin × 各少量 reviews 可绕过单插件上限累计放大。
describe('E210 · isValidAggregateRecord 全局累计 reviews 上限', () => {
  it('多 plugin 累计 reviews 超 2000 → false(各自单插件上限内)', () => {
    const rec: Record<string, ReturnType<typeof aggWithReviews>> = {};
    for (let i = 0; i < 3; i++) rec[`p${i}`] = aggWithReviews(`p${i}`, 700); // 3×700=2100>2000
    expect(isValidAggregateRecord(rec)).toBe(false);
  });

  it('累计恰好 2000 → true(边界)', () => {
    const rec = {
      a: aggWithReviews('a', 1000),
      b: aggWithReviews('b', 1000),
    };
    expect(isValidAggregateRecord(rec)).toBe(true);
  });
});
