import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import {
  ExplorerDecoratorRegistry,
  mergeDecorations,
  type Decoration,
  type DecoratorFn,
} from '../../plugins/registries/ExplorerDecoratorRegistry';
import { Plugin } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

const file = { path: '/a/b.ts', isDirectory: false };

describe('ExplorerDecoratorRegistry', () => {
  it('register / dispose / getAll', () => {
    const r = new ExplorerDecoratorRegistry();
    const fn: DecoratorFn = () => null;
    const d = r.register(fn);
    expect(r.getAll()).toEqual([fn]);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  it('多个 register 按注册顺序返回', () => {
    const r = new ExplorerDecoratorRegistry();
    const a: DecoratorFn = () => null;
    const b: DecoratorFn = () => null;
    r.register(a);
    r.register(b);
    expect(r.getAll()).toEqual([a, b]);
  });

  it('重复 getAll 复用快照,register/dispose 后失效重建', () => {
    const r = new ExplorerDecoratorRegistry();
    const a: DecoratorFn = () => null;
    const b: DecoratorFn = () => null;
    const c: DecoratorFn = () => null;
    const d = r.register(a);
    r.register(b);
    const sliceSpy = vi.spyOn(Array.prototype, 'slice');

    try {
      const first = r.getAll();
      expect(first).toEqual([a, b]);
      expect(sliceSpy).not.toHaveBeenCalled();
      expect(r.getAll()).toBe(first);
      expect(sliceSpy).not.toHaveBeenCalled();

      r.register(c);
      const second = r.getAll();
      expect(second).not.toBe(first);
      expect(second).toEqual([a, b, c]);
      expect(sliceSpy).not.toHaveBeenCalled();

      d.dispose();
      expect(r.getAll()).toEqual([b, c]);
      expect(sliceSpy).not.toHaveBeenCalled();
      expect(ExplorerDecoratorRegistry.prototype.getAll.toString()).not.toContain(
        'fns.push(',
      );
    } finally {
      sliceSpy.mockRestore();
    }
  });

  // race(R57,R55/R56 同族):FileRow 合并装饰时读 live getAll()(而非 useRegistry 快照)。dispose
  // 后 live getAll() 不含该 fn → mergeDecorations 不再执行已移除 decorator(快照滞后期内若用快照
  // 则会执行死函数)。getAll() 返 this.fns.slice() 即时反映,无滞后。
  it('R57 dispose 后 live getAll() 不含该 fn → mergeDecorations 不执行它', () => {
    const r = new ExplorerDecoratorRegistry();
    const spy = vi.fn((): Decoration | null => null);
    const d = r.register(spy);
    d.dispose();
    mergeDecorations(file, r.getAll()); // live 列表已不含 spy
    expect(spy).not.toHaveBeenCalled();
  });

  it('R57 未 dispose 时 live getAll() 含该 fn → mergeDecorations 执行(对照)', () => {
    const r = new ExplorerDecoratorRegistry();
    const spy = vi.fn((): Decoration | null => null);
    r.register(spy);
    mergeDecorations(file, r.getAll());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // 边界(E54,E47 输入侧对偶):register 校验 fn 为函数 + 全局数量上限,挡非函数(每行 render 抛)
  // 与海量 decorator(每行无界 O(N) 调用卡顿)。
  describe('E54 · register 输入校验', () => {
    it('非函数 fn → 抛,不入表', () => {
      const r = new ExplorerDecoratorRegistry();
      expect(() => r.register('nope' as never)).toThrow(/expects a function/i);
      expect(r.getAll()).toEqual([]);
    });

    it('超过数量上限(256)→ 抛', () => {
      const r = new ExplorerDecoratorRegistry();
      for (let i = 0; i < 256; i++) r.register(() => null);
      expect(() => r.register(() => null)).toThrow(/too many decorators/i);
      expect(r.getAll()).toHaveLength(256);
    });

    it('上限内正常注册 → ok', () => {
      const r = new ExplorerDecoratorRegistry();
      const fn: DecoratorFn = () => null;
      expect(() => r.register(fn)).not.toThrow();
      expect(r.getAll()).toEqual([fn]);
    });
  });
});

describe('mergeDecorations', () => {
  it('全 null → 返 null', () => {
    expect(mergeDecorations(file, [() => null, () => null])).toBeNull();
  });

  it('单个非 null → 透传', () => {
    const dec: Decoration = { badge: 'M', textColor: 'red' };
    expect(mergeDecorations(file, [() => dec])).toEqual(dec);
  });

  it('badge:取首个非空', () => {
    const result = mergeDecorations(file, [
      () => null,
      () => ({ badge: 'A', badgeColor: '#f00' }),
      () => ({ badge: 'B', badgeColor: '#0f0' }),
    ]);
    expect(result?.badge).toBe('A');
    expect(result?.badgeColor).toBe('#f00');
  });

  it('textColor:后者赢(最近覆盖)', () => {
    const result = mergeDecorations(file, [
      () => ({ textColor: 'red' }),
      () => ({ textColor: 'blue' }),
    ]);
    expect(result?.textColor).toBe('blue');
  });

  it('tooltip:全部 · 拼接', () => {
    const result = mergeDecorations(file, [
      () => ({ tooltip: 'modified' }),
      () => null,
      () => ({ tooltip: '12 lines added' }),
    ]);
    expect(result?.tooltip).toBe('modified · 12 lines added');
  });

  it('decorator fn 抛错 → 跳过该 fn,其它继续', () => {
    const result = mergeDecorations(file, [
      () => {
        throw new Error('boom');
      },
      () => ({ badge: 'A' }),
    ]);
    expect(result?.badge).toBe('A');
  });

  // ── V2:icon 字段(plugin 贡献文件图标)──────────────────────────

  it('icon:取首个非空(跟 badge 同款 first-wins)', () => {
    const iconA = createElement('span', { 'data-id': 'A' });
    const iconB = createElement('span', { 'data-id': 'B' });
    const result = mergeDecorations(file, [
      () => null,
      () => ({ icon: iconA }),
      () => ({ icon: iconB }),
    ]);
    expect(result?.icon).toBe(iconA);
  });

  it('单个非 null icon → 透传', () => {
    const icon = createElement('span', { 'data-id': 'lock' });
    expect(mergeDecorations(file, [() => ({ icon })])).toEqual({ icon });
  });

  it('icon + badge + textColor + tooltip 同时贡献 → 全部 merge', () => {
    const icon = createElement('span', { 'data-id': 'X' });
    const result = mergeDecorations(file, [
      () => ({
        icon,
        badge: 'M',
        textColor: 'red',
        tooltip: 'modified',
      }),
    ]);
    expect(result).toEqual({
      icon,
      badge: 'M',
      badgeColor: undefined,
      textColor: 'red',
      tooltip: 'modified',
    });
  });

  it('全 null + 仅 icon → result 非 null(icon 算"有装饰")', () => {
    const icon = createElement('span', { 'data-id': 'I' });
    const result = mergeDecorations(file, [() => null, () => ({ icon })]);
    expect(result?.icon).toBe(icon);
  });

  // 边界(E47,插件输出校验):mergeDecorations 校验 decorator 返回值的类型/长度/数量,挡畸形
  // decorator 返回超长/非字符串 badge·tooltip(虚拟列表滚动反复拼接巨大 title + 非字符串进 React)。
  describe('E47 · 输出校验', () => {
    it('非字符串 badge/tooltip/textColor → 丢弃(不进 React/title)', () => {
      const result = mergeDecorations(file, [
        () =>
          ({
            badge: 123,
            tooltip: { evil: true },
            textColor: ['red'],
          }) as never,
      ]);
      expect(result).toBeNull(); // 全部非法 → 无有效装饰
    });

    it('超长 badge → 丢弃,让后续合法 badge 赢(first-VALID-wins)', () => {
      const result = mergeDecorations(file, [
        () => ({ badge: 'x'.repeat(65) }), // > 64 → 丢
        () => ({ badge: 'M' }),
      ]);
      expect(result?.badge).toBe('M');
    });

    it('超长 tooltip → 丢弃;合法 tooltip 保留', () => {
      const result = mergeDecorations(file, [
        () => ({ tooltip: 'x'.repeat(1025) }), // > 1024 → 丢
        () => ({ tooltip: 'ok' }),
      ]);
      expect(result?.tooltip).toBe('ok');
    });

    it('tooltip 数量超 32 → 截断到 32', () => {
      const fns = Array.from({ length: 40 }, (_, i) => () => ({
        tooltip: `t${i}`,
      }));
      const result = mergeDecorations(file, fns);
      const count = result?.tooltip?.split(' · ').length ?? 0;
      expect(count).toBe(32);
      expect(mergeDecorations.toString()).not.toContain('tooltips.push(');
    });

    it('合并后总长超上限 → 截断兜底', () => {
      // 32 × 1000 字符 ≈ 32K,> 4096 总长上限 → slice 到 4096。
      const fns = Array.from({ length: 32 }, () => () => ({
        tooltip: 'x'.repeat(1000),
      }));
      const result = mergeDecorations(file, fns);
      expect((result?.tooltip?.length ?? 0)).toBeLessThanOrEqual(4096);
    });
  });
});

describe('Plugin.registerExplorerDecorator 集成', () => {
  const manifest: PluginManifest = {
    id: 'test.deco',
    name: 'Deco',
    version: '0.1.0',
  };

  it('注册 + _deactivate 自动移除', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {
        this.registerExplorerDecorator(() => ({ badge: 'X' }));
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.explorerDecorators.getAll()).toHaveLength(1);
    await p._deactivate();
    expect(app.explorerDecorators.getAll()).toHaveLength(0);
  });
});
