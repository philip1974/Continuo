import { describe, it, expect, vi } from 'vitest';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { Plugin } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

const noopRender = () => null;

describe('SettingTabRegistry', () => {
  it('register / dispose / getAll', () => {
    const r = new SettingTabRegistry();
    const d = r.register({ id: 'a', title: 'A', render: noopRender });
    expect(r.getAll().map((x) => x.id)).toEqual(['a']);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  it('priority 升序;缺失默认 100', () => {
    const r = new SettingTabRegistry();
    r.register({ id: 'def', title: 'D', render: noopRender });
    r.register({ id: 'top', title: 'T', render: noopRender, priority: 1 });
    r.register({ id: 'bot', title: 'B', render: noopRender, priority: 200 });
    expect(r.getAll().map((x) => x.id)).toEqual(['top', 'def', 'bot']);
  });

  it('重复 id → 后注册赢 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new SettingTabRegistry();
    r.register({ id: 'dup', title: 'A', render: noopRender });
    r.register({ id: 'dup', title: 'B', render: noopRender });
    expect(r.getAll()).toHaveLength(1);
    expect(r.getAll()[0]!.title).toBe('B');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('subscribe 在 register/dispose 触发', () => {
    const r = new SettingTabRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    const d = r.register({ id: 'a', title: 'A', render: noopRender });
    d.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('Plugin.addSettingTab 集成', () => {
  const manifest: PluginManifest = {
    id: 'test.set',
    name: 'Set',
    version: '0.1.0',
  };

  it('addSettingTab 注册 + _deactivate 自动移除', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {
        this.addSettingTab({
          id: 'mine',
          title: 'Mine',
          render: noopRender,
        });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.settingTabs.getAll().map((x) => x.id)).toEqual(['mine']);
    await p._deactivate();
    expect(app.settingTabs.getAll()).toEqual([]);
  });
});
