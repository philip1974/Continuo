// BDD: registry-capacity (E236,E79/E54 注册表数量上限族)
// 共享容量 helper + 全 8 个 Map 型 registry 的数量上限 + 家族接线守卫。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  assertRegistryCapacity,
  MAX_REGISTRY_ITEMS,
} from '../../plugins/registries/registry-capacity';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';

describe('assertRegistryCapacity(E236)', () => {
  it('未达上限 → 放行(不抛)', () => {
    expect(() => assertRegistryCapacity('x', 0, false)).not.toThrow();
    expect(() =>
      assertRegistryCapacity('x', MAX_REGISTRY_ITEMS - 1, false),
    ).not.toThrow();
  });

  it('达上限 + 新 id → 抛', () => {
    expect(() =>
      assertRegistryCapacity('x', MAX_REGISTRY_ITEMS, false),
    ).toThrow(/too many registered items/);
  });

  it('达上限但覆盖既有 id(isExistingId=true)→ 放行(不增长)', () => {
    expect(() =>
      assertRegistryCapacity('x', MAX_REGISTRY_ITEMS, true),
    ).not.toThrow();
    expect(() =>
      assertRegistryCapacity('x', MAX_REGISTRY_ITEMS * 2, true),
    ).not.toThrow();
  });
});

describe('CommandRegistry 数量上限集成(E236)', () => {
  it('注册到上限,第上限+1 个(新 id)被拒,dispose 后释放名额可再注册', () => {
    const reg = new CommandRegistry();
    const disposers = [];
    for (let i = 0; i < MAX_REGISTRY_ITEMS; i++) {
      disposers.push(reg.register({ id: `c${i}`, title: `t${i}`, fn: () => {} }));
    }
    expect(reg.getAll()).toHaveLength(MAX_REGISTRY_ITEMS);
    // 上限+1 新 id → 抛,不入表
    expect(() =>
      reg.register({ id: 'overflow', title: 'of', fn: () => {} }),
    ).toThrow(/too many registered items/);
    expect(reg.getAll()).toHaveLength(MAX_REGISTRY_ITEMS);
    // 覆盖既有 id(c0)→ 即便满也放行
    expect(() =>
      reg.register({ id: 'c0', title: 'c0-again', fn: () => {} }),
    ).not.toThrow();
    // dispose 一个释放名额 → 可再注册新 id
    disposers[1]!.dispose();
    expect(reg.getAll()).toHaveLength(MAX_REGISTRY_ITEMS - 1);
    expect(() =>
      reg.register({ id: 'after-dispose', title: 'x', fn: () => {} }),
    ).not.toThrow();
    expect(reg.getAll()).toHaveLength(MAX_REGISTRY_ITEMS);
  });
});

// 家族接线守卫:全 8 个 Map 型 registry 都必须调用共享 helper(防某个兄弟漏接/回归)。
describe('E236 家族接线守卫:全部 Map 型 registry 调用 assertRegistryCapacity', () => {
  const REGISTRIES = [
    'CommandRegistry',
    'EditorActionRegistry',
    'ExplorerContextMenuRegistry',
    'PanelRegistry',
    'RibbonRegistry',
    'SettingItemRegistry',
    'SettingTabRegistry',
    'StatusBarRegistry',
  ];
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../plugins/registries',
  );
  it.each(REGISTRIES)('%s 的 register() 调用 assertRegistryCapacity', (name) => {
    const src = readFileSync(path.join(dir, `${name}.ts`), 'utf-8');
    expect(src).toContain('assertRegistryCapacity(');
  });
});
