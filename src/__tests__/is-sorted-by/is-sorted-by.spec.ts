// BDD:「已有序则跳过排序」判断的共享实现。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSortedBy } from '../../lib/is-sorted-by';

const here = path.dirname(fileURLToPath(import.meta.url));
const byNumber = (a: number, b: number) => a - b;

describe('isSortedBy', () => {
  it('空列表与单项 → true', () => {
    expect(isSortedBy([], byNumber)).toBe(true);
    expect(isSortedBy([3], byNumber)).toBe(true);
  });

  it('非降序(含相等项)→ true', () => {
    expect(isSortedBy([1, 2, 2, 5], byNumber)).toBe(true);
  });

  it('任一相邻逆序 → false', () => {
    expect(isSortedBy([1, 3, 2], byNumber)).toBe(false);
    expect(isSortedBy([2, 1], byNumber)).toBe(false);
  });

  it('按比较器语义判断(localeCompare)', () => {
    const byName = (a: { n: string }, b: { n: string }) => a.n.localeCompare(b.n);
    expect(isSortedBy([{ n: 'a' }, { n: 'b' }], byName)).toBe(true);
    expect(isSortedBy([{ n: 'b' }, { n: 'a' }], byName)).toBe(false);
  });

  it('不修改入参', () => {
    const items = [3, 1, 2];
    isSortedBy(items, byNumber);
    expect(items).toEqual([3, 1, 2]);
  });
});

describe('接线守卫:调用方都走共享实现', () => {
  it.each([
    '../../plugins/command-palette/CommandPalette.tsx',
    '../../plugins/settings/KeybindingsTabContent.tsx',
    '../../panels/Explorer/ContextMenu.tsx',
  ])('%s', (rel) => {
    const src = readFileSync(path.join(here, rel), 'utf-8');
    expect(src).toContain('isSortedBy(');
    expect(src).not.toMatch(
      /function (isSortedByDisplayTitle|areBucketsSortedByCategory|arePluginItemBucketsSorted)\(/,
    );
  });
});
