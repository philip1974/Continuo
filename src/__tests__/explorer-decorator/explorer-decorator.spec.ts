import { describe, it, expect } from 'vitest';
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
