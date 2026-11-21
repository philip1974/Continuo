import { describe, it, expect, vi } from 'vitest';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';
import { Plugin } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

const noop = () => {};

describe('RibbonRegistry', () => {
  it('register / dispose / getAll', () => {
    const r = new RibbonRegistry();
    const d = r.register({
      id: 'a',
      title: 'A',
      icon: null,
      onClick: noop,
    });
    expect(r.getAll().map((x) => x.id)).toEqual(['a']);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  it('空 registry 的 getAll 复用稳定空快照', () => {
    const r = new RibbonRegistry();
    const other = new RibbonRegistry();
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll()).toEqual([]);
      expect(r.getAll()).toBe(other.getAll());
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('priority 升序;缺失默认 100', () => {
    const r = new RibbonRegistry();
    r.register({ id: 'def', title: 'D', icon: null, onClick: noop });
    r.register({ id: 'top', title: 'T', icon: null, onClick: noop, priority: 1 });
    r.register({ id: 'bot', title: 'B', icon: null, onClick: noop, priority: 200 });
    expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def', 'bot']);
  });

  it('getAll 构造排序快照时按 Map size 预分配,不通过 items.push 扩容', () => {
    const r = new RibbonRegistry();
    r.register({ id: 'b', title: 'B', icon: null, onClick: noop, priority: 2 });
    r.register({ id: 'a', title: 'A', icon: null, onClick: noop, priority: 1 });

    expect(r.getAll().map((x) => x.id)).toEqual(['a', 'b']);
    expect(RibbonRegistry.prototype.getAll.toString()).not.toContain(
      'items.push(',
    );
  });

  it('已按 priority 注册时复用构建顺序,不调用 sort', () => {
    const r = new RibbonRegistry();
    r.register({ id: 'top', title: 'T', icon: null, onClick: noop, priority: 1 });
    r.register({ id: 'mid', title: 'M', icon: null, onClick: noop, priority: 100 });
    r.register({ id: 'bot', title: 'B', icon: null, onClick: noop, priority: 200 });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'mid', 'bot']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('重复 getAll 复用排序结果,register/dispose 后失效重建', () => {
    const r = new RibbonRegistry();
    const d = r.register({ id: 'def', title: 'D', icon: null, onClick: noop });
    r.register({ id: 'top', title: 'T', icon: null, onClick: noop, priority: 1 });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def']);
      expect(sortSpy).toHaveBeenCalledTimes(1);
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def']);
      expect(sortSpy).toHaveBeenCalledTimes(1);

      r.register({ id: 'bot', title: 'B', icon: null, onClick: noop, priority: 200 });
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def', 'bot']);
      expect(sortSpy).toHaveBeenCalledTimes(2);

      d.dispose();
      expect(r.getAll().map((x) => x.id)).toEqual(['top', 'bot']);
      expect(sortSpy).toHaveBeenCalledTimes(2);
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('单项快照不调用 sort', () => {
    const r = new RibbonRegistry();
    r.register({ id: 'a', title: 'A', icon: null, onClick: noop });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((x) => x.id)).toEqual(['a']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('subscribe 在 register/dispose 时触发', () => {
    const r = new RibbonRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    const d = r.register({ id: 'a', title: 'A', icon: null, onClick: noop });
    d.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // race(R52,R51 同族):NavRailButton 的 onClick 捕获 spec,插件 unregister 后旧 handler 仍可
  // 触发 → click 时按 id 从 live registry 重查执行。get(id) 提供该 live 查找,dispose 后返 undefined。
  describe('get(id) live 查找(R52)', () => {
    it('register → get(id) 返回 spec;dispose 后返 undefined', () => {
      const r = new RibbonRegistry();
      const d = r.register({ id: 'a', title: 'A', icon: null, onClick: noop });
      expect(r.get('a')?.id).toBe('a');
      d.dispose();
      expect(r.get('a')).toBeUndefined();
    });

    it('get 返回当前 live spec(重复 id 后注册赢)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = new RibbonRegistry();
      r.register({ id: 'x', title: 'old', icon: null, onClick: noop });
      r.register({ id: 'x', title: 'new', icon: null, onClick: noop });
      expect(r.get('x')?.title).toBe('new');
      warn.mockRestore();
    });
  });

  it('重复 id → 后注册赢 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new RibbonRegistry();
    r.register({ id: 'dup', title: 'A', icon: null, onClick: noop });
    r.register({ id: 'dup', title: 'B', icon: null, onClick: noop });
    expect(r.getAll()).toHaveLength(1);
    expect(r.getAll()[0]!.title).toBe('B');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // 边界(E49,E35/E36/E37/E40/E48 兄弟 registry):register 校验 id/title 长度 + priority finite
  // + onClick 为函数。畸形项进 Activity Bar 排序/渲染,超长 title 污染 tooltip,非函数 onClick 点击崩。
  describe('E49 · 贡献项边界校验', () => {
    it('合法 spec → ok', () => {
      const r = new RibbonRegistry();
      expect(() =>
        r.register({ id: 'a', title: 'A', icon: null, onClick: noop }),
      ).not.toThrow();
    });

    it('超长 id/title → 抛,不入 registry', () => {
      const r = new RibbonRegistry();
      expect(() =>
        r.register({
          id: 'x'.repeat(257),
          title: 'T',
          icon: null,
          onClick: noop,
        }),
      ).toThrow(/id exceeds max length/i);
      expect(() =>
        r.register({
          id: 'a',
          title: 'T'.repeat(513),
          icon: null,
          onClick: noop,
        }),
      ).toThrow(/title exceeds max length/i);
      expect(r.getAll()).toEqual([]);
    });

    it('空 id/title → 抛', () => {
      const r = new RibbonRegistry();
      expect(() =>
        r.register({ id: '', title: 'T', icon: null, onClick: noop }),
      ).toThrow(/id must be a non-empty/i);
      expect(() =>
        r.register({ id: 'a', title: '', icon: null, onClick: noop }),
      ).toThrow(/title must be a non-empty/i);
    });

    it('非有限 priority / onClick 非函数 → 抛', () => {
      const r = new RibbonRegistry();
      expect(() =>
        r.register({
          id: 'a',
          title: 'T',
          icon: null,
          onClick: noop,
          priority: Infinity,
        }),
      ).toThrow(/priority must be finite/i);
      expect(() =>
        r.register({
          id: 'b',
          title: 'T',
          icon: null,
          onClick: 'nope' as never,
        }),
      ).toThrow(/onClick must be a function/i);
    });
  });
});

describe('Plugin.addRibbonAction 集成', () => {
  const makeApp = () => createTestApp();

  const manifest: PluginManifest = {
    id: 'test.ribbon',
    name: 'Ribbon',
    version: '0.1.0',
  };

  it('addRibbonAction 注册 + _deactivate 自动移除', async () => {
    const app = makeApp();
    class P extends Plugin {
      onload() {
        this.addRibbonAction({
          id: 'mine',
          title: 'Mine',
          icon: null,
          onClick: noop,
        });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.ribbon.getAll().map((x) => x.id)).toEqual(['mine']);
    await p._deactivate();
    expect(app.ribbon.getAll()).toEqual([]);
  });
});
