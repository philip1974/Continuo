// BDD:按 key 分组的共享实现。见同目录 README。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupKeepingOrder } from '../../lib/group-keeping-order';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('groupKeepingOrder', () => {
  it('空列表 → 空数组', () => {
    expect(groupKeepingOrder([], (x: string) => x)).toEqual([]);
  });

  it('全部同 key(含单项)→ 一个组,复用入参数组', () => {
    const one = [{ k: 'a', v: 1 }];
    const same = [
      { k: 'a', v: 1 },
      { k: 'a', v: 2 },
    ];
    for (const input of [one, same]) {
      const groups = groupKeepingOrder(input, (x) => x.k);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.key).toBe('a');
      expect(groups[0]!.items).toBe(input);
      expect(groups[0]!.owned).toBe(false);
    }
  });

  it('多个 key → 组顺序 = 首次出现顺序,组内顺序不变,items 为新数组', () => {
    const input = [
      { k: 'b', v: 1 },
      { k: 'a', v: 2 },
      { k: 'b', v: 3 },
      { k: 'c', v: 4 },
      { k: 'a', v: 5 },
    ];
    const snapshot = JSON.stringify(input);
    const groups = groupKeepingOrder(input, (x) => x.k);
    expect(groups.map((g) => g.key)).toEqual(['b', 'a', 'c']);
    expect(groups.map((g) => g.items.map((x) => x.v))).toEqual([[1, 3], [2, 5], [4]]);
    expect(groups.every((g) => g.owned)).toBe(true);
    expect(groups.every((g) => g.items !== input)).toBe(true);
    expect(JSON.stringify(input)).toBe(snapshot); // 不修改入参
  });

  it('key 可以是 undefined', () => {
    const groups = groupKeepingOrder(
      [{ g: undefined as string | undefined }, { g: 'x' }, { g: undefined }],
      (x) => x.g,
    );
    expect(groups.map((g) => g.key)).toEqual([undefined, 'x']);
    expect(groups[0]!.items).toHaveLength(2);
  });
});

describe('接线守卫:四个调用方都走共享实现', () => {
  it.each([
    '../../plugins/settings/SettingsPanel.tsx',
    '../../plugins/settings/CategoryTabContent.tsx',
    '../../plugins/settings/KeybindingsTabContent.tsx',
    '../../panels/Explorer/ContextMenu.tsx',
  ])('%s', (rel) => {
    expect(readFileSync(path.join(here, rel), 'utf-8')).toContain('groupKeepingOrder(');
  });
});
