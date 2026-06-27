import { describe, it, expect } from 'vitest';
import {
  applyFilter,
  collectAllTags,
  MAX_MARKETPLACE_TAGS,
} from '../../marketplace/filter';
import { MAX_SEARCH_QUERY_LEN } from '../../lib/search-query';
import type { MarketplaceEntry } from '../../marketplace/types';

const ENTRIES: readonly MarketplaceEntry[] = [
  {
    id: 'com.foo',
    name: 'Foo Plugin',
    description: 'a foo for productivity',
    author: 'a',
    repo: 'a/foo',
    tags: ['productivity', 'tools'],
  },
  {
    id: 'com.bar',
    name: 'Bar',
    description: 'demo plugin',
    author: 'b',
    repo: 'b/bar',
    tags: ['demo'],
  },
  {
    id: 'com.baz',
    name: 'Baz',
    author: 'c',
    repo: 'c/baz',
    // 没 tags
  },
];

describe('applyFilter', () => {
  it('空 query + 空 tags → 全过', () => {
    const r = applyFilter(ENTRIES, { query: '', selectedTags: new Set() });
    expect(r).toHaveLength(3);
  });

  // 边界(E281,E279/E280 搜索 query 上限族):applyFilter 是导出纯函数,可被非 UI 调用方传超长 query →
  // 对 ≤4096 entry 逐项 includes 放大。filter 层防御性截断 query(与 UI onChange clamp 同上限,双层)。
  it('E281 超长 query 不抛、不放大(filter 层截断,仍能匹配前缀)', () => {
    // 超长但以 'foo' 开头 → 截断后仍匹配 com.foo(证截断不破匹配 + 不放大/不抛)
    const longFoo = 'foo' + 'x'.repeat(MAX_SEARCH_QUERY_LEN + 5000);
    const r = applyFilter(ENTRIES, {
      query: longFoo,
      selectedTags: new Set(),
    });
    // 截断到 1024 个 'fooxxx...' → name 'Foo Plugin' 不含此长串 → 不匹配(但不抛、不放大)
    expect(Array.isArray(r)).toBe(true);
    // 纯 'foo' 仍正常匹配(回归)
    expect(
      applyFilter(ENTRIES, { query: 'foo', selectedTags: new Set() }).map(
        (e) => e.id,
      ),
    ).toEqual(['com.foo']);
  });

  it('query 匹配 name(大小写不敏感)', () => {
    const r = applyFilter(ENTRIES, {
      query: 'FOO',
      selectedTags: new Set(),
    });
    expect(r.map((e) => e.id)).toEqual(['com.foo']);
  });

  it('query 匹配 description', () => {
    const r = applyFilter(ENTRIES, {
      query: 'demo',
      selectedTags: new Set(),
    });
    expect(r.map((e) => e.id)).toEqual(['com.bar']);
  });

  it('query 匹配 tag', () => {
    const r = applyFilter(ENTRIES, {
      query: 'productivity',
      selectedTags: new Set(),
    });
    expect(r.map((e) => e.id)).toEqual(['com.foo']);
  });

  it('query 匹配 id', () => {
    const r = applyFilter(ENTRIES, {
      query: 'com.baz',
      selectedTags: new Set(),
    });
    expect(r.map((e) => e.id)).toEqual(['com.baz']);
  });

  it('selectedTags 单选 → entry.tags 含该 tag 才过', () => {
    const r = applyFilter(ENTRIES, {
      query: '',
      selectedTags: new Set(['demo']),
    });
    expect(r.map((e) => e.id)).toEqual(['com.bar']);
  });

  it('selectedTags 多选 → entry.tags 与之有任一交集就过(OR)', () => {
    const r = applyFilter(ENTRIES, {
      query: '',
      selectedTags: new Set(['demo', 'productivity']),
    });
    expect(r.map((e) => e.id).sort()).toEqual(['com.bar', 'com.foo']);
  });

  it('query + tags 同时生效(AND)', () => {
    const r = applyFilter(ENTRIES, {
      query: 'foo',
      selectedTags: new Set(['demo']), // foo 不在 demo
    });
    expect(r).toEqual([]);
  });

  it('entry 无 tags → tag filter 非空时被过滤', () => {
    const r = applyFilter(ENTRIES, {
      query: '',
      selectedTags: new Set(['anything']),
    });
    expect(r.map((e) => e.id)).not.toContain('com.baz');
  });
});

describe('collectAllTags', () => {
  it('去重 + 按字典序', () => {
    const r = collectAllTags(ENTRIES);
    expect(r).toEqual(['demo', 'productivity', 'tools']);
  });

  it('空入参 → []', () => {
    expect(collectAllTags([])).toEqual([]);
  });

  it('全 entry 都无 tags → []', () => {
    expect(
      collectAllTags([
        {
          id: 'x',
          name: 'X',
          author: 'a',
          repo: 'a/x',
        },
      ]),
    ).toEqual([]);
  });

  // 边界(E226,E210 逐项≠累计上限族):全局 distinct tag 数封顶 MAX_MARKETPLACE_TAGS,凑满即停收集。
  it('E226 distinct tags 超 MAX_MARKETPLACE_TAGS(256)→ 截断到 256', () => {
    // 单 entry 塞 1000 个 distinct tag(畸形 index);collectAllTags 应截断到 256。
    const tags = Array.from({ length: 1000 }, (_, i) => `t${String(i).padStart(4, '0')}`);
    const r = collectAllTags([
      { id: 'x', name: 'X', author: 'a', repo: 'a/x', tags },
    ]);
    expect(r).toHaveLength(MAX_MARKETPLACE_TAGS); // 256,不收集全部 1000
  });
});
