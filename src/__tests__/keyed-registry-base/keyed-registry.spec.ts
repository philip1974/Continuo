// 重构守卫:Map 型贡献 registry 共享基类 KeyedRegistry 的行为契约 + 家族接线。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KeyedRegistry,
  filterKeepingIdentity,
  snapshotByPriority,
} from '../../plugins/registries/keyed-registry';
import { MAX_REGISTRY_ITEMS } from '../../plugins/registries/registry-capacity';
import type { Disposable } from '../../plugins/types';

interface Spec {
  readonly id: string;
  readonly priority?: number;
}

class TestRegistry extends KeyedRegistry<Spec> {
  readonly events: string[] = [];
  invalidations = 0;
  builds = 0;

  constructor() {
    super('test-registry');
  }

  register(spec: Spec): Disposable {
    return this.registerKeyed(spec.id, spec);
  }

  size(): number {
    return this.items.size;
  }

  protected buildSnapshot(): readonly Spec[] {
    this.builds += 1;
    return snapshotByPriority(this.items);
  }

  protected override onSnapshotInvalidated(): void {
    this.invalidations += 1;
    this.events.push('invalidate');
  }

  protected override onBeforeSet(spec: Spec, previous: Spec | undefined): void {
    this.events.push(`before:${spec.id}:${previous ? 'override' : 'new'}`);
  }

  protected override onRemoved(spec: Spec): void {
    this.events.push(`removed:${spec.id}`);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KeyedRegistry.registerKeyed', () => {
  it('入表后先失效快照再通知;get 取 live spec', () => {
    const reg = new TestRegistry();
    reg.subscribe(() => reg.events.push('notify'));
    const spec = { id: 'a' };
    reg.register(spec);
    expect(reg.get('a')).toBe(spec);
    expect(reg.events).toEqual(['before:a:new', 'invalidate', 'notify']);
  });

  it('覆盖既有 key → warn + 后注册者赢', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new TestRegistry();
    reg.register({ id: 'a' });
    const second = { id: 'a' };
    reg.register(second);
    expect(warn).toHaveBeenCalledWith(
      '[test-registry] id "a" 已注册,后注册赢覆盖前者',
    );
    expect(reg.get('a')).toBe(second);
    expect(reg.events).toContain('before:a:override');
  });

  it('dispose 幂等;只删自己,被顶替后 dispose 是 no-op', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new TestRegistry();
    const listener = vi.fn();
    const first = reg.register({ id: 'a' });
    const secondSpec = { id: 'a' };
    const second = reg.register(secondSpec);
    reg.subscribe(listener);

    first.dispose();
    expect(reg.get('a')).toBe(secondSpec);
    expect(listener).not.toHaveBeenCalled();

    second.dispose();
    second.dispose();
    expect(reg.get('a')).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.events.slice(-2)).toEqual(['removed:a', 'invalidate']);
  });

  it('容量守卫:新 key 超限抛且不入表、不触发钩子;覆盖既有 key 放行', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new TestRegistry();
    for (let i = 0; i < MAX_REGISTRY_ITEMS; i += 1) reg.register({ id: `k${i}` });
    reg.events.length = 0;
    expect(() => reg.register({ id: 'overflow' })).toThrow(
      /\[test-registry\] too many registered items/,
    );
    expect(reg.size()).toBe(MAX_REGISTRY_ITEMS);
    expect(reg.events).toEqual([]);
    expect(() => reg.register({ id: 'k0' })).not.toThrow();
  });

  it('unsubscribe 后不再通知', () => {
    const reg = new TestRegistry();
    const listener = vi.fn();
    const off = reg.subscribe(listener);
    off();
    reg.register({ id: 'a' });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('KeyedRegistry.getAll(基类持有的全量快照缓存)', () => {
  it('两次变更之间返回同一引用,只构造一次;变更后失效重建', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new TestRegistry();
    reg.register({ id: 'a', priority: 2 });
    const d = reg.register({ id: 'b', priority: 1 });
    const first = reg.getAll();
    expect(first.map((x) => x.id)).toEqual(['b', 'a']);
    expect(reg.getAll()).toBe(first);
    expect(reg.builds).toBe(1);

    d.dispose();
    const second = reg.getAll();
    expect(second).not.toBe(first);
    expect(second.map((x) => x.id)).toEqual(['a']);
    expect(reg.builds).toBe(2);
  });

  it('空表返回共享空数组(跨实例同一引用),不调 buildSnapshot', () => {
    const a = new TestRegistry();
    const b = new TestRegistry();
    expect(a.getAll()).toEqual([]);
    expect(a.getAll()).toBe(b.getAll());
    expect(a.builds).toBe(0);
  });
});

describe('snapshotByPriority', () => {
  it('按 priority ?? 100 升序,等优先级保持注册顺序', () => {
    const items = new Map<string, Spec>([
      ['a', { id: 'a', priority: 200 }],
      ['b', { id: 'b' }],
      ['c', { id: 'c', priority: 50 }],
      ['d', { id: 'd', priority: 100 }],
    ]);
    expect(snapshotByPriority(items).map((x) => x.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('已有序时不调用 sort', () => {
    const items = new Map<string, Spec>([
      ['a', { id: 'a', priority: 1 }],
      ['b', { id: 'b', priority: 2 }],
    ]);
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    expect(snapshotByPriority(items).map((x) => x.id)).toEqual(['a', 'b']);
    expect(sortSpy).not.toHaveBeenCalled();
  });
});

describe('家族接线守卫:8 个 Map 型 registry 继承 KeyedRegistry', () => {
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
  it.each(REGISTRIES)('%s 继承基类且无内联样板', (name) => {
    const src = readFileSync(path.join(dir, `${name}.ts`), 'utf-8');
    expect(src).toMatch(new RegExp(`class ${name} extends KeyedRegistry<`));
    expect(src).toContain('this.registerKeyed(');
    expect(src).not.toContain('private listeners');
    expect(src).not.toContain('let disposed = false');
  });
});

describe('filterKeepingIdentity', () => {
  const EMPTY: number[] = [];

  it('全部通过 → 返回入参数组本身', () => {
    const items = [1, 2, 3];
    expect(filterKeepingIdentity(items, () => true, EMPTY)).toBe(items);
  });

  it('部分滤掉 → 新数组,保持原序', () => {
    const items = [1, 2, 3, 4, 5];
    const out = filterKeepingIdentity(items, (n) => n % 2 === 1, EMPTY);
    expect(out).toEqual([1, 3, 5]);
    expect(out).not.toBe(items);
    expect(filterKeepingIdentity(items, (n) => n > 1, EMPTY)).toEqual([2, 3, 4, 5]);
  });

  it('全被滤掉 → 返回共享空数组引用;空入参原样返回', () => {
    expect(filterKeepingIdentity([1, 2], () => false, EMPTY)).toBe(EMPTY);
    const none: number[] = [];
    expect(filterKeepingIdentity(none, () => false, EMPTY)).toBe(none);
  });

  it('每项只调一次谓词', () => {
    const keep = vi.fn((n: number) => n !== 2);
    filterKeepingIdentity([1, 2, 3], keep, EMPTY);
    expect(keep).toHaveBeenCalledTimes(3);
  });
});
