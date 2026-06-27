// 打磨 R55(codex 性能):CommandPalette 空 query 排序 recent 置顶时,不在 comparator
// 里反复 recentIds.indexOf;改为一次性 rank map。测试直接覆盖纯 helper,避免 UI 渲染噪声。
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

  it('recent 置顶用 rank slot 单趟放置,不再额外 sort recent 小数组', () => {
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
      expect(sortSpy).toHaveBeenCalledTimes(1);
    } finally {
      sortSpy.mockRestore();
    }
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
});
