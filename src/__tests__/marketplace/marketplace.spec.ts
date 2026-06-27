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
  fetchPluginManifest,
  MAX_INDEX_ENTRIES,
  selectValidMarketplaceEntries,
} from '../../marketplace/fetcher';
import {
  entryToGitUrl,
  entryToManifestUrl,
  isValidMarketplaceEntry,
  type MarketplaceEntry,
} from '../../marketplace/types';
import { readResponseTextCapped } from '../../../electron/shared/read-capped';

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

describe('selectValidMarketplaceEntries', () => {
  it('用一次循环保留合法 entry,不通过 filter 物化', () => {
    const raw: readonly unknown[] = [
      SAMPLE_ENTRY,
      { ...SAMPLE_ENTRY, id: 'bad id' },
      { ...SAMPLE_ENTRY, id: 'com.example.bar', repo: 'me/bar' },
    ];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const entries = selectValidMarketplaceEntries(raw);
      const filterCallsDuringSelect = filterSpy.mock.calls.length;
      expect(entries.map((entry) => entry.id)).toEqual([
        'com.example.foo',
        'com.example.bar',
      ]);
      expect(filterCallsDuringSelect).toBe(0);
    } finally {
      filterSpy.mockRestore();
    }
  });
});

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

// 边界(E25,E2 同族强化):isValidMarketplaceEntry 此前只校验字段类型,不限制 id/name/author/
// repo/branch/description/tags 的长度、tags 数量,也不约束 repo 为两段安全 GitHub owner/name。
// 远程 index 可放超长字段或海量 tags,进 session cache 后在过滤/排序/卡片渲染/manifest URL 拼接
// 放大 CPU/内存;畸形 repo 还会生成异常 raw/github URL。超限/非法 entry 须被判非法(过滤掉)。
describe('isValidMarketplaceEntry bounds (E25)', () => {
  const base: MarketplaceEntry = {
    id: 'com.example.foo',
    name: 'Foo',
    author: 'me',
    repo: 'me/foo-plugin',
  };

  it('合法 entry → true', () => {
    expect(isValidMarketplaceEntry(base)).toBe(true);
    expect(
      isValidMarketplaceEntry({ ...base, branch: 'feature/x', tags: ['a'] }),
    ).toBe(true);
  });

  it('repo/branch 段级校验不通过 split 物化路径段', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(
        isValidMarketplaceEntry({
          ...base,
          repo: 'owner.x/repo-y',
          branch: 'feature/foo-bar',
        }),
      ).toBe(true);
      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      splitSpy.mockRestore();
    }
  });

  it('超长 id/name/author/description → false', () => {
    expect(isValidMarketplaceEntry({ ...base, id: 'x'.repeat(257) })).toBe(
      false,
    );
    expect(isValidMarketplaceEntry({ ...base, name: 'x'.repeat(257) })).toBe(
      false,
    );
    expect(isValidMarketplaceEntry({ ...base, author: 'x'.repeat(257) })).toBe(
      false,
    );
    expect(
      isValidMarketplaceEntry({ ...base, description: 'x'.repeat(4097) }),
    ).toBe(false);
  });

  it('E110 id 须符合 plugin manifest 契约(charset + 非 ./..)', () => {
    // 合法:小写字母数字 + . _ -
    expect(isValidMarketplaceEntry({ ...base, id: 'com.example.foo-bar_1' })).toBe(
      true,
    );
    // 非法字符:空格 / & / # / 斜杠 / 大写 → 状态索引错配 + query 注入
    for (const bad of [
      'has space',
      'a&b',
      'a#b',
      'a/b',
      '../x',
      'UpperCase',
      '[bracket]',
    ]) {
      expect(isValidMarketplaceEntry({ ...base, id: bad })).toBe(false);
    }
    // 纯点段(路径穿越语义)→ false
    expect(isValidMarketplaceEntry({ ...base, id: '.' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, id: '..' })).toBe(false);
  });

  it('repo 非两段安全 owner/name → false', () => {
    expect(isValidMarketplaceEntry({ ...base, repo: 'no-slash' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, repo: 'a/b/c' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, repo: 'a/b c' })).toBe(false);
    expect(
      isValidMarketplaceEntry({ ...base, repo: '../etc/passwd' }),
    ).toBe(false);
    expect(
      isValidMarketplaceEntry({ ...base, repo: 'owner/name?x=1' }),
    ).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, repo: 'me/foo-plugin' })).toBe(
      true,
    );
  });

  // 边界(E107,E104 同类):repo 两段中含 ./.. 点段 → URL 归一化路径穿越。旧 REPO_RE 字符集含
  // '.' 放行 '../x'(2 段:owner='..'),逐段拒点段后必 false。
  it('E107 repo 含点段(../x、a/..)→ false', () => {
    expect(isValidMarketplaceEntry({ ...base, repo: '../x' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, repo: 'a/..' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, repo: './x' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, repo: 'x/.' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, repo: '..' })).toBe(false); // 单段
    // 合法两段 repo 仍通过
    expect(isValidMarketplaceEntry({ ...base, repo: 'owner.x/repo-y' })).toBe(
      true,
    );
  });

  // 边界(E108):authorUrl 只校验长度会放行 javascript:/file: 等危险协议(UI 直接 <a href>)。
  // 只接受可解析的 http/https URL。
  it('E108 authorUrl 危险协议 → false,http/https → true', () => {
    expect(
      isValidMarketplaceEntry({ ...base, authorUrl: 'javascript:alert(1)' }),
    ).toBe(false);
    expect(
      isValidMarketplaceEntry({ ...base, authorUrl: 'file:///etc/passwd' }),
    ).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, authorUrl: 'smb://x/y' })).toBe(
      false,
    );
    expect(isValidMarketplaceEntry({ ...base, authorUrl: 'not a url' })).toBe(
      false,
    );
    expect(
      isValidMarketplaceEntry({ ...base, authorUrl: 'https://example.com/u' }),
    ).toBe(true);
    expect(
      isValidMarketplaceEntry({ ...base, authorUrl: 'http://example.com' }),
    ).toBe(true);
    // authorUrl 可选:undefined 仍合法
    expect(isValidMarketplaceEntry({ ...base, authorUrl: undefined })).toBe(true);
  });

  it('branch 含非安全字符 → false', () => {
    expect(isValidMarketplaceEntry({ ...base, branch: 'a b' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, branch: 'a;rm -rf' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, branch: 'x'.repeat(257) })).toBe(
      false,
    );
    expect(isValidMarketplaceEntry({ ...base, branch: 'release/v1.2' })).toBe(
      true,
    );
  });

  // 边界(E104):branch 段级校验 —— 拒 ..、前导/尾随 /、连续 //(防 entryToManifestUrl 拼出
  // 逃出 owner/repo/<branch>/ 结构的路径穿越 URL)。
  it('E104 branch 路径穿越/畸形段 → false', () => {
    expect(
      isValidMarketplaceEntry({ ...base, branch: '../../other/repo/main' }),
    ).toBe(false); // 路径穿越
    expect(isValidMarketplaceEntry({ ...base, branch: '..' })).toBe(false);
    expect(isValidMarketplaceEntry({ ...base, branch: 'a/../b' })).toBe(false); // 中间 .. 段
    expect(isValidMarketplaceEntry({ ...base, branch: '/main' })).toBe(false); // 前导 /
    expect(isValidMarketplaceEntry({ ...base, branch: 'main/' })).toBe(false); // 尾随 /
    expect(isValidMarketplaceEntry({ ...base, branch: 'a//b' })).toBe(false); // 连续 //
    expect(isValidMarketplaceEntry({ ...base, branch: '.' })).toBe(false);
    // 合法多段 branch 仍通过
    expect(
      isValidMarketplaceEntry({ ...base, branch: 'feature/foo-bar' }),
    ).toBe(true);
  });

  it('tags 数量超 64 或单个超长 → false', () => {
    expect(
      isValidMarketplaceEntry({
        ...base,
        tags: Array.from({ length: 65 }, (_, i) => `t${i}`),
      }),
    ).toBe(false);
    expect(
      isValidMarketplaceEntry({ ...base, tags: ['x'.repeat(129)] }),
    ).toBe(false);
    expect(
      isValidMarketplaceEntry({
        ...base,
        tags: Array.from({ length: 64 }, (_, i) => `t${i}`),
      }),
    ).toBe(true);
  });
});

// 边界(E124):readResponseTextCapped 按真实字节流式硬截断(旧 readJsonCapped 在大小检查前
// await r.text() 全读入,且 text.length 是 UTF-16 code unit 数非字节 → 多字节 UTF-8 绕过上限)。
describe('readResponseTextCapped (E124)', () => {
  const tooLarge = () => new Error('TOO_LARGE');

  it('E124 多字节 UTF-8 真实字节超上限(text.length 未超)→ 抛', async () => {
    // '中' = 3 bytes UTF-8 / 1 UTF-16 code unit。50 个:byteLength=150,text.length=50。
    const bytes = new TextEncoder().encode('中'.repeat(50)); // 150 bytes
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const resp = new Response(stream); // ReadableStream body → 无 content-length
    // maxBytes=100:真实字节 150 > 100 应抛;旧 text.length=50 ≤ 100 会误放行。
    await expect(readResponseTextCapped(resp, 100, tooLarge)).rejects.toThrow(
      'TOO_LARGE',
    );
  });

  it('E124 Content-Length 缺失 + 流式累计超上限 → 抛(不全读)', async () => {
    const big = new TextEncoder().encode('x'.repeat(5000));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const resp = new Response(stream);
    await expect(readResponseTextCapped(resp, 1000, tooLarge)).rejects.toThrow(
      'TOO_LARGE',
    );
  });

  it('E124 Content-Length 预检超上限 → 抛', async () => {
    const resp = new Response('{}', {
      headers: { 'content-length': '999999' },
    });
    await expect(readResponseTextCapped(resp, 1000, tooLarge)).rejects.toThrow(
      'TOO_LARGE',
    );
  });

  it('E124 正常小响应 → 原样返回文本', async () => {
    const resp = new Response('{"ok":true}');
    await expect(readResponseTextCapped(resp, 1_000_000, tooLarge)).resolves.toBe(
      '{"ok":true}',
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

  // 边界(E121,E111 读/写不对称同族):fresh path 把 index 截到 MAX_INDEX_ENTRIES,但缓存读端
  // 此前无数量上限。篡改/旧版本 sessionStorage 塞超量合法小 entry → 应当 cache miss(走网络)。
  it('E121 缓存 entry 数超 MAX_INDEX_ENTRIES → cache miss(走网络,不返超量缓存)', async () => {
    const many = Array.from({ length: MAX_INDEX_ENTRIES + 1 }, (_, i) => ({
      ...SAMPLE_ENTRY,
      id: `com.example.e${i}`,
    }));
    // beforeEach 已 reset in-memory + clear sessionStorage;此处只 seed 超量缓存到 sessionStorage。
    sessionStorage.setItem(
      'continuo:marketplace:index',
      JSON.stringify({ fetchedAt: Date.now(), data: many }),
    );
    const f = mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    const r = await fetchMarketplaceIndex();
    expect(f).toHaveBeenCalledTimes(1); // 超量缓存当 miss → 走网络
    expect(r).toHaveLength(1); // 返回网络结果,而非超大缓存
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
    // i18n(I5):抛稳定 code(非中文 prose),caller 按 catalog 本地化渲染
    await expect(fetchMarketplaceIndex()).rejects.toThrow(
      /MARKETPLACE_INDEX_INVALID/,
    );
  });

  // 边界(E2):index.json 含畸形 entry(null/缺 repo/字段类型错)不得通过 → 过滤掉,保留合法项,
  // 防其在 filter/渲染/更新检查触发 TypeError 崩面板或拼出 github.com/undefined.git。
  it('E2 畸形 entry 被过滤,合法 entry 保留', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch({
      ok: true,
      data: [
        SAMPLE_ENTRY, // 合法
        null, // 畸形:null
        { id: 'x', name: 'X', author: 'a' }, // 畸形:缺 repo
        { id: 'y', name: 'Y', author: 'a', repo: 'no-slash' }, // 畸形:repo 无 '/'
        { id: 'z', name: 'Z', author: 'a', repo: 'a/b', tags: {} }, // 畸形:tags 非数组
        { id: 'w', name: 'W', author: 'a', repo: 'a/b', verified: 'yes' }, // 畸形:verified 非 bool
        { id: 'ok2', name: 'OK2', author: 'a', repo: 'a/b' }, // 合法(可选字段缺省)
      ],
    });
    const r = await fetchMarketplaceIndex();
    expect(r.map((e) => e.id).sort()).toEqual(['com.example.foo', 'ok2']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped 5 malformed'),
    );
  });

  it('E25 超长字段/海量 tags/畸形 repo entry 被过滤,不进缓存', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch({
      ok: true,
      data: [
        SAMPLE_ENTRY, // 合法
        { id: 'big', name: 'X'.repeat(300), author: 'a', repo: 'a/b' }, // 超长 name
        {
          id: 'tags',
          name: 'T',
          author: 'a',
          repo: 'a/b',
          tags: Array.from({ length: 200 }, (_, i) => `t${i}`),
        }, // 海量 tags
        { id: 'bad', name: 'B', author: 'a', repo: 'a/b/c' }, // 畸形 repo(三段)
      ],
    });
    const r = await fetchMarketplaceIndex();
    expect(r.map((e) => e.id)).toEqual(['com.example.foo']);
  });

  it('E2 全部畸形 → 返空数组(不崩,fail-safe)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch({ ok: true, data: [null, { id: 'x' }, 42] });
    const r = await fetchMarketplaceIndex();
    expect(r).toEqual([]);
  });

  it('E2 sessionStorage 缓存含畸形 entry → 视为不可用,重新拉网络', async () => {
    // 外部篡改/旧格式:persisted 缓存含畸形项 → cache.validate 的 every() 失败 → 当无缓存。
    sessionStorage.setItem(
      'continuo:marketplace:index',
      JSON.stringify({
        fetchedAt: Date.now(),
        data: [{ id: 'bad' /* 缺 name/author/repo */ }],
      }),
    );
    const f = mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    const r = await fetchMarketplaceIndex();
    expect(r.map((e) => e.id)).toEqual(['com.example.foo']);
    expect(f).toHaveBeenCalledTimes(1); // 畸形缓存被弃,走了网络
  });

  // 边界(E5):缓存时间戳此前只校验 typeof === 'number',畸形 sessionStorage 写 1e309(JSON.parse
  // → Infinity)或远未来值会通过,使 Date.now()-fetchedAt < ttlMs 恒真 → 永久用陈旧缓存。须拒收。
  it('E5 缓存时间戳为 Infinity(1e309)→ 当 cache miss,走网络', async () => {
    sessionStorage.setItem(
      'continuo:marketplace:index',
      '{"fetchedAt":1e309,"data":[' + JSON.stringify(SAMPLE_ENTRY) + ']}',
    );
    const f = mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    await fetchMarketplaceIndex();
    expect(f).toHaveBeenCalledTimes(1); // Infinity 时间戳被拒 → 走网络
  });

  it('E5 缓存时间戳为远未来 → 当 cache miss,走网络', async () => {
    sessionStorage.setItem(
      'continuo:marketplace:index',
      JSON.stringify({ fetchedAt: Date.now() + 1e12, data: [SAMPLE_ENTRY] }),
    );
    const f = mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    await fetchMarketplaceIndex();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('E5 缓存时间戳为负 → 当 cache miss,走网络', async () => {
    sessionStorage.setItem(
      'continuo:marketplace:index',
      JSON.stringify({ fetchedAt: -1, data: [SAMPLE_ENTRY] }),
    );
    const f = mockFetch({ ok: true, data: [SAMPLE_ENTRY] });
    await fetchMarketplaceIndex();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sessionStorage hydrate:memory 空时从 sessionStorage 读', async () => {
    // 模拟"已经写过 sessionStorage,但 memory 是空"
    // M19:缓存样板统一为 createSessionCache 的 { fetchedAt, data } 形态。
    sessionStorage.setItem(
      'continuo:marketplace:index',
      JSON.stringify({
        fetchedAt: Date.now(),
        data: [SAMPLE_ENTRY],
      }),
    );
    const f = mockFetch({ ok: true, data: [] });
    const r = await fetchMarketplaceIndex();
    expect(r).toHaveLength(1);
    expect(f).not.toHaveBeenCalled(); // sessionStorage 命中,没走网络
  });

  // 边界(E64,E57 renderer 同族):index.json 响应体上限(解析前拦)+ 顶层数组条目数硬上限。
  it('E64 响应体 Content-Length 超上限 → 拒(无 cache 时抛)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', {
        status: 200,
        headers: { 'content-length': String(5 * 1024 * 1024) }, // > 4MiB 上限
      }),
    );
    await expect(fetchMarketplaceIndex()).rejects.toThrow(
      /MARKETPLACE_RESPONSE_TOO_LARGE/,
    );
  });

  it('E64 顶层数组条目数超上限 → 截断到 MAX_INDEX_ENTRIES', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: MAX_INDEX_ENTRIES + 50 }, (_, i) => ({
      ...SAMPLE_ENTRY,
      id: `com.example.e${i}`,
    }));
    mockFetch({ ok: true, data: many });
    const r = await fetchMarketplaceIndex();
    expect(r).toHaveLength(MAX_INDEX_ENTRIES); // 封顶,不无界缓存
  });

  it('E64 顶层数组超上限时按索引有界遍历,不 slice 复制大 index', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: MAX_INDEX_ENTRIES + 50 }, (_, i) => ({
      ...SAMPLE_ENTRY,
      id: `com.example.e${i}`,
    }));
    mockFetch({ ok: true, data: many });
    const sliceSpy = vi.spyOn(Array.prototype, 'slice');

    try {
      const r = await fetchMarketplaceIndex();

      expect(r).toHaveLength(MAX_INDEX_ENTRIES);
      expect(sliceSpy).not.toHaveBeenCalled();
    } finally {
      sliceSpy.mockRestore();
    }
  });
});

describe('fetchPluginManifest', () => {
  beforeEach(() => {
    _resetMarketplaceCacheForTest();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ok=true + 完整 manifest → 返 id/name/version', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'a', name: 'A', version: '1.0.0', extra: 'ignored' }),
        { status: 200 },
      ),
    );
    const r = await fetchPluginManifest(SAMPLE_ENTRY);
    expect(r).toEqual({ id: 'a', name: 'A', version: '1.0.0' });
  });

  it('HTTP 非 2xx → 抛 HTTP {status}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 404 }),
    );
    await expect(fetchPluginManifest(SAMPLE_ENTRY)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('manifest 缺字段 → 抛 invalid id / name / version', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'a', name: 'A' }), { status: 200 }),
    );
    await expect(fetchPluginManifest(SAMPLE_ENTRY)).rejects.toThrow(
      /invalid id \/ name \/ version/,
    );
  });

  // 边界(E80,E74 字段上限族):远端 manifest 复用本地 ManifestSchema 的 id/name/version 校验
  //(.max + SEMVER_RE),防超长字段/非 semver version 进 update-store 放大渲染。
  it('E80 远端 version 超长(非法 semver/超 128)→ 抛,不进 update-store', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'a',
          name: 'A',
          version: `1.0.0-${'x'.repeat(2000)}`, // 1MiB 内但超 VERSION_MAX(128)
        }),
        { status: 200 },
      ),
    );
    await expect(fetchPluginManifest(SAMPLE_ENTRY)).rejects.toThrow(
      /invalid id \/ name \/ version/,
    );
  });

  it('E80 远端 version 非 semver → 抛', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'a', name: 'A', version: 'not-a-semver' }),
        { status: 200 },
      ),
    );
    await expect(fetchPluginManifest(SAMPLE_ENTRY)).rejects.toThrow(
      /invalid id \/ name \/ version/,
    );
  });

  it('E80 合规远端 manifest 仍正常返回', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'com.x', name: 'X', version: '2.3.4' }),
        { status: 200 },
      ),
    );
    await expect(fetchPluginManifest(SAMPLE_ENTRY)).resolves.toEqual({
      id: 'com.x',
      name: 'X',
      version: '2.3.4',
    });
  });

  // 边界(E64):manifest 响应体上限(同 main MANIFEST_MAX_BYTES),解析前拦,不无界 r.json()。
  it('E64 manifest 响应体 Content-Length 超上限 → 抛 MARKETPLACE_RESPONSE_TOO_LARGE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'a', name: 'A', version: '1.0.0' }), {
        status: 200,
        headers: { 'content-length': String(2 * 1024 * 1024) }, // > 1MiB 上限
      }),
    );
    await expect(fetchPluginManifest(SAMPLE_ENTRY)).rejects.toThrow(
      /MARKETPLACE_RESPONSE_TOO_LARGE/,
    );
  });
});
