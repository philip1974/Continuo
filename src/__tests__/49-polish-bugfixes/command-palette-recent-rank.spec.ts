// 打磨 R55(codex 性能):CommandPalette 空 query 排序 recent 置顶时,不在 comparator
// 里反复 recentIds.indexOf;改为一次性 rank map。测试直接覆盖纯 helper,避免 UI 渲染噪声。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  buildRecentCommandIds,
  sortByRecent,
} from '../../plugins/command-palette/CommandPalette';

interface TestDisplayCommand {
  readonly cmd: { readonly id: string };
  readonly displayTitle: string;
}

function command(id: string, title: string): TestDisplayCommand {
  return { cmd: { id }, displayTitle: title };
}

describe('打磨 R55 — CommandPalette recent rank 预计算', () => {
  it('recent id 派生预分配数组,不调用 recentList.map', () => {
    const recentList = [
      { id: 'a', ts: 3 },
      { id: 'b', ts: 2 },
      { id: 'c', ts: 1 },
    ];
    const mapSpy = vi.spyOn(recentList, 'map');
    try {
      expect(buildRecentCommandIds(recentList)).toEqual(['a', 'b', 'c']);
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('空 recent 列表 → 稳定空数组', () => {
    expect(buildRecentCommandIds([])).toEqual([]);
    expect(buildRecentCommandIds([])).toBe(buildRecentCommandIds([]));
  });

  it('空命令列表排序 → 稳定空数组,不 sort/不建 rank Map', () => {
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    const OriginalMap = globalThis.Map;
    let mapCtorCount = 0;
    class CountingMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        mapCtorCount += 1;
        super(entries);
      }
    }
    globalThis.Map = CountingMap as MapConstructor;

    try {
      const out = sortByRecent([], ['a', 'b']);
      expect(out).toEqual([]);
      expect(out).toBe(sortByRecent([], []));
      expect(sortSpy).not.toHaveBeenCalled();
      expect(mapCtorCount).toBe(0);
    } finally {
      sortSpy.mockRestore();
      globalThis.Map = OriginalMap;
    }
  });

  it('单条命令排序 → 复用输入引用,不 sort/不建 rank Map', () => {
    const items = [command('a', 'Alpha')];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    const OriginalMap = globalThis.Map;
    let mapCtorCount = 0;
    class CountingMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        mapCtorCount += 1;
        super(entries);
      }
    }
    globalThis.Map = CountingMap as MapConstructor;

    try {
      const out = sortByRecent(
        items as unknown as Parameters<typeof sortByRecent>[0],
        ['a'],
      );

      expect(out).toBe(items);
      expect(out.map((d) => d.cmd.id)).toEqual(['a']);
      expect(sortSpy).not.toHaveBeenCalled();
      expect(mapCtorCount).toBe(0);
    } finally {
      sortSpy.mockRestore();
      globalThis.Map = OriginalMap;
    }
  });

  it('recent 排序不再反复调用 recentIds.indexOf,且 recent 顺序保持', () => {
    const items = [
      command('a', 'Alpha'),
      command('b', 'Beta'),
      command('c', 'Charlie'),
      command('d', 'Delta'),
    ];
    const recentIds = ['c', 'a'];
    const indexOfSpy = vi.spyOn(Array.prototype, 'indexOf');

    const out = sortByRecent(
      items as unknown as Parameters<typeof sortByRecent>[0],
      recentIds,
    );
    const calls = indexOfSpy.mock.calls.length;
    indexOfSpy.mockRestore();

    expect(calls).toBe(0);
    expect(out.map((d) => d.cmd.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(sortByRecent.toString()).not.toContain('others.push(');
    expect(sortByRecent.toString()).not.toContain('out.push(');
  });

  it('recent 置顶用 rank slot 单趟放置,others 已排序时不 sort', () => {
    const items = [
      command('a', 'Alpha'),
      command('b', 'Beta'),
      command('c', 'Charlie'),
      command('d', 'Delta'),
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const out = sortByRecent(
        items as unknown as Parameters<typeof sortByRecent>[0],
        ['c', 'a'],
      );

      expect(out.map((d) => d.cmd.id)).toEqual(['c', 'a', 'b', 'd']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('recent 置顶后 others 未排序时仍排序一次', () => {
    const items = [
      command('d', 'Delta'),
      command('a', 'Alpha'),
      command('c', 'Charlie'),
      command('b', 'Beta'),
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const out = sortByRecent(
        items as unknown as Parameters<typeof sortByRecent>[0],
        ['c', 'a'],
      );

      expect(out.map((d) => d.cmd.id)).toEqual(['c', 'a', 'b', 'd']);
      expect(sortSpy).toHaveBeenCalledTimes(1);
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('recent rank slots 按 top-N 预分配,不靠稀疏数组扩容', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/command-palette/CommandPalette.tsx'),
      'utf-8',
    );

    expect(src).not.toContain('const recent: (DisplayCommand | undefined)[] = []');
    expect(src).toContain('new Array<DisplayCommand | undefined>(');
    expect(src).toContain('Math.min(recentIds.length, RECENT_TOP_N)');
  });

  it('无 recent 时直接按标题排序,不做 rank map 查找', () => {
    const items = [
      command('c', 'Charlie'),
      command('a', 'Alpha'),
      command('b', 'Beta'),
    ];
    const getSpy = vi.spyOn(Map.prototype, 'get');

    try {
      const out = sortByRecent(
        items as unknown as Parameters<typeof sortByRecent>[0],
        [],
      );

      expect(out.map((d) => d.cmd.id)).toEqual(['a', 'b', 'c']);
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('无 recent 且已按标题排序时复用输入引用,不 sort', () => {
    const items = [
      command('a', 'Alpha'),
      command('b', 'Beta'),
      command('c', 'Charlie'),
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const out = sortByRecent(
        items as unknown as Parameters<typeof sortByRecent>[0],
        [],
      );

      expect(out).toBe(items);
      expect(out.map((d) => d.cmd.id)).toEqual(['a', 'b', 'c']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('单个 recent id 走线性快路径,不构造 rank Map', () => {
    const items = [
      command('a', 'Alpha'),
      command('b', 'Beta'),
      command('c', 'Charlie'),
    ];
    const OriginalMap = globalThis.Map;
    let mapCtorCount = 0;
    class CountingMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        mapCtorCount += 1;
        super(entries);
      }
    }
    globalThis.Map = CountingMap as MapConstructor;

    try {
      const out = sortByRecent(
        items as unknown as Parameters<typeof sortByRecent>[0],
        ['c'],
      );

      expect(out.map((d) => d.cmd.id)).toEqual(['c', 'a', 'b']);
      expect(mapCtorCount).toBe(0);
    } finally {
      globalThis.Map = OriginalMap;
    }
  });

  it('单个 stale recent id 且列表已排序时复用输入引用,不 sort', () => {
    const items = [
      command('a', 'Alpha'),
      command('b', 'Beta'),
      command('c', 'Charlie'),
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const out = sortByRecent(
        items as unknown as Parameters<typeof sortByRecent>[0],
        ['missing'],
      );

      expect(out).toBe(items);
      expect(out.map((d) => d.cmd.id)).toEqual(['a', 'b', 'c']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('单个 stale recent id 快路径先查命中,不预分配 others 数组', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/command-palette/CommandPalette.tsx'),
      'utf-8',
    );

    expect(src).toContain('function findRecentCommandIndex(');
    expect(src.indexOf('const recentIndex = findRecentCommandIndex')).toBeLessThan(
      src.indexOf('const others = new Array<DisplayCommand>(items.length - 1)'),
    );
  });

  it('多个 stale recent id 且列表已排序时复用输入引用,不 sort', () => {
    const items = [
      command('a', 'Alpha'),
      command('b', 'Beta'),
      command('c', 'Charlie'),
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const out = sortByRecent(
        items as unknown as Parameters<typeof sortByRecent>[0],
        ['missing-a', 'missing-b'],
      );

      expect(out).toBe(items);
      expect(out.map((d) => d.cmd.id)).toEqual(['a', 'b', 'c']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });
});
