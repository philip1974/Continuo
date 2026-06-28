import { describe, it, expect, vi } from 'vitest';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import {
  CommandRegistry,
  isValidHotkeyShape,
} from '../../plugins/registries/CommandRegistry';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';
import { subscribeAll } from '../../plugins/registries/useRegistry';

// ── subscribeAll ───────────────────────────────────────

describe('subscribeAll', () => {
  it('空 sources 走 noop 快路径,不订阅也不分配 unsubs 数组', () => {
    const listener = vi.fn();
    const unsubscribeAll = subscribeAll([], listener);

    expect(() => unsubscribeAll()).not.toThrow();
    expect(subscribeAll([], listener)).toBe(unsubscribeAll);
    expect(subscribeAll.toString()).toMatch(/sources\.length === 0/);
    expect(subscribeAll.toString().indexOf('sources.length === 0')).toBeLessThan(
      subscribeAll.toString().indexOf('new Array('),
    );
  });

  it('单 source 直接返回该 source 的 unsubscribe,不分配 unsubs 数组', () => {
    const unsubscribe = vi.fn();
    const source = { subscribe: vi.fn(() => unsubscribe) };
    const listener = vi.fn();

    const unsubscribeAll = subscribeAll([source], listener);

    expect(source.subscribe).toHaveBeenCalledWith(listener);
    unsubscribeAll();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeAll.toString()).toMatch(/sources\.length === 1/);
    expect(subscribeAll.toString().indexOf('sources.length === 1')).toBeLessThan(
      subscribeAll.toString().indexOf('new Array('),
    );
  });

  it('订阅所有 source 并一次性 unsubscribe,不通过 sources.map 生成中间数组', () => {
    const unsubs = [vi.fn(), vi.fn()];
    const sources = [
      { subscribe: vi.fn(() => unsubs[0]!) },
      { subscribe: vi.fn(() => unsubs[1]!) },
    ];
    const listener = vi.fn();
    const mapSpy = vi.spyOn(sources, 'map');

    try {
      const unsubscribeAll = subscribeAll(sources, listener);

      expect(sources[0]!.subscribe).toHaveBeenCalledWith(listener);
      expect(sources[1]!.subscribe).toHaveBeenCalledWith(listener);
      expect(mapSpy).not.toHaveBeenCalled();
      expect(subscribeAll.toString()).not.toContain('unsubs.push(');

      unsubscribeAll();
      expect(unsubs[0]).toHaveBeenCalledTimes(1);
      expect(unsubs[1]).toHaveBeenCalledTimes(1);
    } finally {
      mapSpy.mockRestore();
    }
  });
});

// ── PanelRegistry ───────────────────────────────────────

describe('PanelRegistry', () => {
  it('register → getAll 含;dispose → getAll 不含', () => {
    const r = new PanelRegistry();
    const factory = () => null;
    const d = r.register({ type: 'foo', factory, title: 'Foo' });
    expect(r.getAll().map((x) => x.type)).toEqual(['foo']);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  it('空 registry 的 getAll/list 复用稳定空快照', () => {
    const r = new PanelRegistry();
    const other = new PanelRegistry();

    expect(r.getAll()).toEqual([]);
    expect(r.getAll()).toBe(other.getAll());
    expect(r.list()).toBe(r.getAll());
  });

  it('重复 getAll/list 复用快照,register/dispose 后失效重建', () => {
    const r = new PanelRegistry();
    const d = r.register({ type: 'foo', factory: () => null, title: 'Foo' });
    r.register({ type: 'bar', factory: () => null, title: 'Bar' });
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      expect(r.getAll().map((x) => x.type)).toEqual(['foo', 'bar']);
      expect(arrayFromSpy).not.toHaveBeenCalled();
      expect(r.list().map((x) => x.type)).toEqual(['foo', 'bar']);
      expect(arrayFromSpy).not.toHaveBeenCalled();

      r.register({ type: 'baz', factory: () => null, title: 'Baz' });
      expect(r.getAll().map((x) => x.type)).toEqual(['foo', 'bar', 'baz']);
      expect(arrayFromSpy).not.toHaveBeenCalled();

      d.dispose();
      expect(r.getAll().map((x) => x.type)).toEqual(['bar', 'baz']);
      expect(arrayFromSpy).not.toHaveBeenCalled();
      expect(PanelRegistry.prototype.getAll.toString()).not.toContain(
        'items.push(',
      );
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  // race(R59,R55-R58 同族):DockShell component wrapper 渲染时按 type 从 live registry 查 factory。
  // get(type) 提供 live 查找,dispose 后 undefined → wrapper 渲染空,不实例化已移除插件 factory。
  describe('get(type) live 查找(R59)', () => {
    it('register → get(type) 返回 spec;dispose 后返 undefined', () => {
      const r = new PanelRegistry();
      const d = r.register({ type: 'foo', factory: () => null, title: 'Foo' });
      expect(r.get('foo')?.type).toBe('foo');
      d.dispose();
      expect(r.get('foo')).toBeUndefined();
    });

    it('已 dispose type 经 live 查找跳过,factory 不被调(stale-skip 语义)', () => {
      const r = new PanelRegistry();
      const factory = vi.fn(() => null);
      const d = r.register({ type: 'foo', factory, title: 'Foo' });
      d.dispose();
      const live = r.get('foo');
      if (live) live.factory({});
      expect(factory).not.toHaveBeenCalled();
    });
  });

  it('subscribe 在 register / dispose 时触发', () => {
    const r = new PanelRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    const d = r.register({ type: 'a', factory: () => null, title: 'A' });
    d.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe 后不再触发', () => {
    const r = new PanelRegistry();
    const listener = vi.fn();
    const unsub = r.subscribe(listener);
    unsub();
    r.register({ type: 'a', factory: () => null, title: 'A' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('重复 type → 后注册赢,旧的隐式失效,warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new PanelRegistry();
    const factoryA = () => null;
    const factoryB = () => null;
    r.register({ type: 'dup', factory: factoryA, title: 'A' });
    r.register({ type: 'dup', factory: factoryB, title: 'B' });
    expect(r.getAll()).toHaveLength(1);
    expect(r.getAll()[0]!.title).toBe('B');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('dispose 二次幂等', () => {
    const r = new PanelRegistry();
    const d = r.register({ type: 'a', factory: () => null, title: 'A' });
    d.dispose();
    expect(() => d.dispose()).not.toThrow();
  });

  // 边界(E37,E35/E36 兄弟 registry):register 校验 type/title/titleKey 长度非空 + factory 为函数。
  // 畸形 spec 会污染 Dockview components map / panel id,或在 DockShell 渲染时因 factory 非函数崩。
  describe('E37 · 贡献项边界校验', () => {
    it('合法 spec → ok', () => {
      const r = new PanelRegistry();
      expect(() =>
        r.register({ type: 'foo', factory: () => null, title: 'Foo' }),
      ).not.toThrow();
    });

    it('超长 type / title / titleKey → 抛,不入 registry', () => {
      const r = new PanelRegistry();
      expect(() =>
        r.register({
          type: 'x'.repeat(257),
          factory: () => null,
          title: 'T',
        }),
      ).toThrow(/type exceeds max length/i);
      expect(() =>
        r.register({ type: 'a', factory: () => null, title: 'T'.repeat(513) }),
      ).toThrow(/title exceeds max length/i);
      expect(() =>
        r.register({
          type: 'b',
          factory: () => null,
          title: 'T',
          titleKey: 'k'.repeat(257),
        }),
      ).toThrow(/titleKey exceeds max length/i);
      expect(r.getAll()).toEqual([]);
    });

    it('空 type / 空 title → 抛', () => {
      const r = new PanelRegistry();
      expect(() =>
        r.register({ type: '', factory: () => null, title: 'T' }),
      ).toThrow(/type must be a non-empty/i);
      expect(() =>
        r.register({ type: 'a', factory: () => null, title: '' }),
      ).toThrow(/title must be a non-empty/i);
    });

    it('factory 非函数 → 抛(防 DockShell 渲染崩)', () => {
      const r = new PanelRegistry();
      expect(() =>
        r.register({
          type: 'a',
          factory: 'not-a-fn' as never,
          title: 'T',
        }),
      ).toThrow(/factory must be a function/i);
    });

    // 边界(E153,与 CommandRegistry 同族):可选 titleKey 此前只有 length 上限无 typeof 守卫
    // (titleKey:123 经 `(123).length === undefined > max` 为 false 绕过)→ 补 typeof 校验。
    it('E153 titleKey 非字符串 → 抛', () => {
      const r = new PanelRegistry();
      expect(() =>
        r.register({
          type: 'a',
          factory: () => null,
          title: 'T',
          titleKey: 123 as never,
        }),
      ).toThrow(/titleKey must be a string/i);
    });
  });
});

// ── CommandRegistry ─────────────────────────────────────

describe('CommandRegistry', () => {
  it('register / dispose / getAll', () => {
    const r = new CommandRegistry();
    const d = r.register({ id: 'cmd.foo', title: 'Foo', fn: () => {} });
    expect(r.getAll().map((c) => c.id)).toEqual(['cmd.foo']);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  it('空 registry 的 getAll 复用稳定空快照', () => {
    const r = new CommandRegistry();

    expect(r.getAll()).toEqual([]);
    expect(r.getAll()).toBe(new CommandRegistry().getAll());
  });

  it('重复 getAll 复用快照,register/dispose 后失效重建且不通过 Array.from(values)', () => {
    const r = new CommandRegistry();
    const d = r.register({ id: 'a', title: 'A', fn: () => {} });
    r.register({ id: 'b', title: 'B', fn: () => {} });
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      const first = r.getAll();
      expect(first.map((c) => c.id)).toEqual(['a', 'b']);
      expect(r.getAll()).toBe(first);
      expect(arrayFromSpy).not.toHaveBeenCalled();

      r.register({ id: 'c', title: 'C', fn: () => {} });
      const second = r.getAll();
      expect(second).not.toBe(first);
      expect(second.map((c) => c.id)).toEqual(['a', 'b', 'c']);
      expect(arrayFromSpy).not.toHaveBeenCalled();

      d.dispose();
      expect(r.getAll().map((c) => c.id)).toEqual(['b', 'c']);
      expect(arrayFromSpy).not.toHaveBeenCalled();
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('execute(id) 调对应 fn', async () => {
    const r = new CommandRegistry();
    const fn = vi.fn();
    r.register({ id: 'cmd.run', title: 'Run', fn });
    await r.execute('cmd.run');
    expect(fn).toHaveBeenCalled();
  });

  it('execute 不存在的 id → 抛错', async () => {
    const r = new CommandRegistry();
    await expect(r.execute('nope')).rejects.toThrow(/not found/i);
  });

  it('hotkey 冲突 → 后注册赢 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new CommandRegistry();
    r.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn: () => {} });
    r.register({ id: 'b', title: 'B', hotkey: 'mod+s', fn: () => {} });
    expect(warn).toHaveBeenCalled();
    // 两个 command 都还在(只是 hotkey 冲突,getAll 不去重)
    expect(r.getAll()).toHaveLength(2);
    warn.mockRestore();
  });

  it('hotkey 冲突检测使用索引,注册时不扫描 items.values()', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const valuesSpy = vi.spyOn(Map.prototype, 'values');
    const r = new CommandRegistry();

    try {
      r.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn: () => {} });
      r.register({ id: 'b', title: 'B', hotkey: 'mod+k', fn: () => {} });
      r.register({ id: 'c', title: 'C', hotkey: 'mod+s', fn: () => {} });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(valuesSpy).not.toHaveBeenCalled();
    } finally {
      valuesSpy.mockRestore();
      warn.mockRestore();
    }
  });

  // 边界(E35):register 校验贡献项长度 + hotkey 形态(防恶意插件超长字段/异常 hotkey 进全局
  // registry 拖慢命令面板/快捷键编译/UI 渲染)。非法 spec 抛可诊断错误、不入 registry。
  describe('E35 · 贡献项边界校验', () => {
    it('标点主键 hotkey(mod+, / mod+/)→ 合法', () => {
      const r = new CommandRegistry();
      expect(() =>
        r.register({ id: 'a', title: 'A', hotkey: 'mod+,', fn: () => {} }),
      ).not.toThrow();
      expect(() =>
        r.register({ id: 'b', title: 'B', hotkey: 'mod+/', fn: () => {} }),
      ).not.toThrow();
      expect(() =>
        r.register({
          id: 'c',
          title: 'C',
          hotkey: 'shift+mod+enter',
          fn: () => {},
        }),
      ).not.toThrow();
    });

    it('超长 title → 抛,不入 registry', () => {
      const r = new CommandRegistry();
      expect(() =>
        r.register({ id: 'x', title: 'T'.repeat(513), fn: () => {} }),
      ).toThrow(/title.*max length/i);
      expect(r.getAll()).toEqual([]);
    });

    it('超长 id / category / titleKey → 抛', () => {
      const r = new CommandRegistry();
      expect(() =>
        r.register({ id: 'x'.repeat(257), title: 'T', fn: () => {} }),
      ).toThrow(/id.*max length/i);
      expect(() =>
        r.register({
          id: 'y',
          title: 'T',
          category: 'c'.repeat(257),
          fn: () => {},
        }),
      ).toThrow(/category.*max length/i);
      expect(() =>
        r.register({
          id: 'z',
          title: 'T',
          titleKey: 'k'.repeat(257),
          fn: () => {},
        }),
      ).toThrow(/titleKey.*max length/i);
    });

    it('超长 hotkey → 抛', () => {
      const r = new CommandRegistry();
      expect(() =>
        r.register({
          id: 'x',
          title: 'T',
          hotkey: 'mod+' + 'a'.repeat(64),
          fn: () => {},
        }),
      ).toThrow(/hotkey.*max length/i);
    });

    it('异常 hotkey 形态(空段/含空白)→ 抛', () => {
      const r = new CommandRegistry();
      expect(() =>
        r.register({ id: 'x', title: 'T', hotkey: 'mod++s', fn: () => {} }),
      ).toThrow(/invalid hotkey/i);
      expect(() =>
        r.register({ id: 'y', title: 'T', hotkey: 'mod + s', fn: () => {} }),
      ).toThrow(/invalid hotkey/i);
    });

    it('hotkey 形态校验走字符扫描,不调用 RegExp.test', () => {
      const r = new CommandRegistry();
      const testSpy = vi.spyOn(RegExp.prototype, 'test');
      try {
        expect(isValidHotkeyShape('mod+shift+/')).toBe(true);
        expect(isValidHotkeyShape('mod+\u00A0')).toBe(false);
        expect(() =>
          r.register({ id: 'scan', title: 'Scan', hotkey: 'mod+s', fn: () => {} }),
        ).not.toThrow();
        const err = (() => {
          try {
            r.register({ id: 'bad', title: 'Bad', hotkey: 'mod++s', fn: () => {} });
            return null;
          } catch (e) {
            return e;
          }
        })();
        expect(err).toBeInstanceOf(Error);
        expect(String((err as Error).message)).toContain('invalid hotkey');
        expect(testSpy).not.toHaveBeenCalled();
      } finally {
        testSpy.mockRestore();
      }
    });
  });

  // 边界(E153,E37 兄弟):CommandSpec 来自未类型化第三方 JS plugin,TS 类型不构成运行时保证。
  // E35 只按 .length 做上限,假设字段都是 string;畸形 spec(id:{}/title:123/hotkey:42/fn:'x')
  // 会绕过 length 校验进 registry,后续 execute/分发按 string/function 使用 → 崩溃或不可触发命令。
  // register 边界须显式校验运行时类型 + 必填非空(对齐 PanelRegistry E37)。
  describe('E153 · 贡献项运行时类型校验', () => {
    // 用 unknown 强转模拟未类型化 JS plugin 传入畸形 spec。
    const bad =
      (spec: unknown) => (r: CommandRegistry) =>
        r.register(spec as never);

    it('id 非字符串(对象/数字)→ 抛 + 不入 registry', () => {
      const r = new CommandRegistry();
      expect(() => bad({ id: {}, title: 'T', fn: () => {} })(r)).toThrow(
        /id must be a non-empty string/i,
      );
      expect(() => bad({ id: 42, title: 'T', fn: () => {} })(r)).toThrow(
        /id must be a non-empty string/i,
      );
      expect(r.getAll()).toEqual([]);
    });

    it('id 空字符串 → 抛', () => {
      const r = new CommandRegistry();
      expect(() => bad({ id: '', title: 'T', fn: () => {} })(r)).toThrow(
        /id must be a non-empty string/i,
      );
    });

    it('title 非字符串 / 空 → 抛', () => {
      const r = new CommandRegistry();
      expect(() => bad({ id: 'a', title: 123, fn: () => {} })(r)).toThrow(
        /title must be a non-empty string/i,
      );
      expect(() => bad({ id: 'a', title: '', fn: () => {} })(r)).toThrow(
        /title must be a non-empty string/i,
      );
    });

    it('fn 非函数(字符串/缺失)→ 抛(防 execute 调用崩溃)', () => {
      const r = new CommandRegistry();
      expect(() => bad({ id: 'a', title: 'T', fn: 'x' })(r)).toThrow(
        /fn must be a function/i,
      );
      expect(() => bad({ id: 'a', title: 'T' })(r)).toThrow(
        /fn must be a function/i,
      );
    });

    it('可选字段非字符串(hotkey:42 / category:{} / titleKey:1)→ 抛', () => {
      const r = new CommandRegistry();
      // hotkey:42 此前经 String 强转能通过 HOTKEY_SHAPE_RE → 现 typeof 守卫拦下
      expect(() =>
        bad({ id: 'a', title: 'T', hotkey: 42, fn: () => {} })(r),
      ).toThrow(/hotkey.*must be a string/i);
      expect(() =>
        bad({ id: 'b', title: 'T', category: {}, fn: () => {} })(r),
      ).toThrow(/category.*must be a string/i);
      expect(() =>
        bad({ id: 'c', title: 'T', titleKey: 1, fn: () => {} })(r),
      ).toThrow(/titleKey.*must be a string/i);
      expect(r.getAll()).toEqual([]);
    });

    it('合法 spec 仍 ok(回归)', () => {
      const r = new CommandRegistry();
      expect(() =>
        r.register({ id: 'a', title: 'T', hotkey: 'mod+k', fn: () => {} }),
      ).not.toThrow();
      expect(r.getAll()).toHaveLength(1);
    });
  });
});

// ── StatusBarRegistry ───────────────────────────────────

describe('StatusBarRegistry', () => {
  it('register / dispose / getBySide', () => {
    const r = new StatusBarRegistry();
    const d = r.register({
      id: 'git',
      side: 'left',
      render: () => null,
    });
    expect(r.getBySide('left').map((x) => x.id)).toEqual(['git']);
    expect(r.getBySide('right')).toEqual([]);
    d.dispose();
    expect(r.getBySide('left')).toEqual([]);
  });

  it('空 registry 的 getAll/getBySide 复用稳定空快照', () => {
    const r = new StatusBarRegistry();
    const other = new StatusBarRegistry();
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll()).toEqual([]);
      expect(r.getAll()).toBe(other.getAll());
      expect(r.getBySide('left')).toBe(other.getBySide('left'));
      expect(r.getBySide('right')).toBe(other.getBySide('right'));
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('priority 升序排序', () => {
    const r = new StatusBarRegistry();
    r.register({ id: 'b', side: 'right', priority: 20, render: () => null });
    r.register({ id: 'a', side: 'right', priority: 10, render: () => null });
    r.register({ id: 'c', side: 'right', priority: 30, render: () => null });
    expect(r.getBySide('right').map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('已按 priority 注册时 getBySide/getAll 不调用 sort', () => {
    const bySide = new StatusBarRegistry();
    bySide.register({ id: 'a', side: 'right', priority: 10, render: () => null });
    bySide.register({ id: 'b', side: 'right', priority: 20, render: () => null });
    bySide.register({ id: 'c', side: 'right', priority: 30, render: () => null });
    const all = new StatusBarRegistry();
    all.register({ id: 'left', side: 'left', priority: 1, render: () => null });
    all.register({ id: 'right.a', side: 'right', priority: 20, render: () => null });
    all.register({ id: 'right.b', side: 'right', priority: 30, render: () => null });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(bySide.getBySide('right').map((x) => x.id)).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect(all.getAll().map((x) => x.id)).toEqual([
        'left',
        'right.a',
        'right.b',
      ]);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('重复读取同一快照时复用排序结果,register/dispose 后失效重建', () => {
    const r = new StatusBarRegistry();
    const d = r.register({ id: 'b', side: 'right', priority: 20, render: () => null });
    r.register({ id: 'a', side: 'right', priority: 10, render: () => null });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getBySide('right').map((x) => x.id)).toEqual(['a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(1);
      expect(r.getBySide('right').map((x) => x.id)).toEqual(['a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(1);

      const allAfterRight = r.getAll();
      expect(allAfterRight.map((x) => x.id)).toEqual(['a', 'b']);
      expect(allAfterRight).toBe(r.getBySide('right'));
      expect(sortSpy).toHaveBeenCalledTimes(1);
      expect(r.getAll().map((x) => x.id)).toEqual(['a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(1);

      r.register({ id: 'c', side: 'right', priority: 5, render: () => null });
      expect(r.getBySide('right').map((x) => x.id)).toEqual(['c', 'a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(2);

      d.dispose();
      expect(r.getBySide('right').map((x) => x.id)).toEqual(['c', 'a']);
      expect(sortSpy).toHaveBeenCalledTimes(3);
      expect(StatusBarRegistry.prototype.getBySide.toString()).not.toContain(
        'items.push(',
      );
      expect(StatusBarRegistry.prototype.getAll.toString()).not.toContain(
        'items.push(',
      );
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('单项或空侧边快照不调用 sort', () => {
    const r = new StatusBarRegistry();
    const empty = new StatusBarRegistry();
    r.register({ id: 'left', side: 'left', render: () => null });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getBySide('left').map((x) => x.id)).toEqual(['left']);
      expect(r.getBySide('right')).toEqual([]);
      expect(r.getBySide('right')).toBe(empty.getBySide('right'));
      expect(r.getAll().map((x) => x.id)).toEqual(['left']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('getBySide 不先 Array.from(values) 物化全部条目', () => {
    const r = new StatusBarRegistry();
    r.register({ id: 'left', side: 'left', render: () => null });
    r.register({ id: 'right', side: 'right', render: () => null });
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      expect(r.getBySide('left').map((x) => x.id)).toEqual(['left']);
      expect(arrayFromSpy).not.toHaveBeenCalled();
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  // race(R56,R55 同族):StatusBar 渲染前按 id 从 live registry 复查再调 render,避免调 useRegistry
  // 快照滞后期内已 unregister 的 item 的 render。get(id) 提供该 live 查找。
  describe('get(id) live 查找(R56)', () => {
    it('register → get(id) 返回 spec;dispose 后返 undefined', () => {
      const r = new StatusBarRegistry();
      const d = r.register({ id: 'git', side: 'left', render: () => null });
      expect(r.get('git')?.id).toBe('git');
      d.dispose();
      expect(r.get('git')).toBeUndefined();
    });

    it('已 dispose item 经 live 查找跳过,render 不被调(stale-skip 语义)', () => {
      const r = new StatusBarRegistry();
      const render = vi.fn(() => null);
      const d = r.register({ id: 'git', side: 'left', render });
      d.dispose();
      const live = r.get('git');
      if (live) live.render();
      expect(render).not.toHaveBeenCalled();
    });
  });

  it('priority 缺失 → 默认 100,与显式 100 后注册赢', () => {
    const r = new StatusBarRegistry();
    r.register({ id: 'def', side: 'left', render: () => null });
    r.register({ id: 'high', side: 'left', priority: 1, render: () => null });
    expect(r.getBySide('left').map((x) => x.id)).toEqual(['high', 'def']);
  });

  it('subscribe → register/dispose 触发回调', () => {
    const r = new StatusBarRegistry();
    let count = 0;
    const unsub = r.subscribe(() => count++);
    const d = r.register({ id: 'a', side: 'left', render: () => null });
    expect(count).toBe(1);
    d.dispose();
    expect(count).toBe(2);
    unsub();
    r.register({ id: 'b', side: 'left', render: () => null });
    expect(count).toBe(2);
  });

  it('重复 id register → console.warn,后注册赢', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new StatusBarRegistry();
    r.register({ id: 'a', side: 'left', render: () => null });
    r.register({ id: 'a', side: 'right', render: () => null });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('id "a" 已注册'),
    );
    expect(r.getBySide('left')).toHaveLength(0);
    expect(r.getBySide('right')).toHaveLength(1);
    warn.mockRestore();
  });

  it('dispose 幂等;dispose 后被新 register 顶替的 spec 不再被旧 disposable 删', () => {
    const r = new StatusBarRegistry();
    const d1 = r.register({ id: 'a', side: 'left', render: () => null });
    d1.dispose();
    d1.dispose(); // 二次 dispose 静默
    expect(r.getBySide('left')).toEqual([]);

    const d2 = r.register({ id: 'a', side: 'left', render: () => null });
    // d1 与 d2 的内部 spec 引用不同;d1.dispose 不应删 d2 注册的
    d1.dispose();
    expect(r.getBySide('left').map((x) => x.id)).toEqual(['a']);
    d2.dispose();
  });

  // 边界(E50,E35-E49 兄弟 registry):register 校验 id 长度 + side 枚举 + priority finite + render
  // 为函数。非法 side 变不可见脏条目,NaN priority 让排序失真,非函数 render 每次重渲反复告警。
  describe('E50 · 贡献项边界校验', () => {
    it('合法 spec → ok', () => {
      const r = new StatusBarRegistry();
      expect(() =>
        r.register({ id: 'a', side: 'left', render: () => null }),
      ).not.toThrow();
    });

    it('超长 id / 空 id → 抛,不入 registry', () => {
      const r = new StatusBarRegistry();
      expect(() =>
        r.register({ id: 'x'.repeat(257), side: 'left', render: () => null }),
      ).toThrow(/id exceeds max length/i);
      expect(() =>
        r.register({ id: '', side: 'left', render: () => null }),
      ).toThrow(/id must be a non-empty/i);
      expect(r.getAll()).toEqual([]);
    });

    it('非法 side → 抛(防不可见脏条目)', () => {
      const r = new StatusBarRegistry();
      expect(() =>
        r.register({
          id: 'a',
          side: 'middle' as never,
          render: () => null,
        }),
      ).toThrow(/side must be/i);
    });

    it('非有限 priority / render 非函数 → 抛', () => {
      const r = new StatusBarRegistry();
      expect(() =>
        r.register({
          id: 'a',
          side: 'left',
          priority: NaN,
          render: () => null,
        }),
      ).toThrow(/priority must be finite/i);
      expect(() =>
        r.register({ id: 'b', side: 'left', render: 'nope' as never }),
      ).toThrow(/render must be a function/i);
    });
  });
});
