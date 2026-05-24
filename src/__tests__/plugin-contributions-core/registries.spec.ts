import { describe, it, expect, vi } from 'vitest';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';

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

  it('priority 升序排序', () => {
    const r = new StatusBarRegistry();
    r.register({ id: 'b', side: 'right', priority: 20, render: () => null });
    r.register({ id: 'a', side: 'right', priority: 10, render: () => null });
    r.register({ id: 'c', side: 'right', priority: 30, render: () => null });
    expect(r.getBySide('right').map((x) => x.id)).toEqual(['a', 'b', 'c']);
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
});
