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

  it('priority 升序;缺失默认 100', () => {
    const r = new RibbonRegistry();
    r.register({ id: 'def', title: 'D', icon: null, onClick: noop });
    r.register({ id: 'top', title: 'T', icon: null, onClick: noop, priority: 1 });
    r.register({ id: 'bot', title: 'B', icon: null, onClick: noop, priority: 200 });
    expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def', 'bot']);
  });

  it('subscribe 在 register/dispose 时触发', () => {
    const r = new RibbonRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    const d = r.register({ id: 'a', title: 'A', icon: null, onClick: noop });
    d.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
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
