import { describe, it, expect } from 'vitest';
import {
  applyFilter,
  collectAllTags,
} from '../../marketplace/filter';
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
});
