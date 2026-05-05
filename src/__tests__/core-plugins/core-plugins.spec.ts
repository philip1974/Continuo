// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';

beforeEach(async () => {
  // 确保起始干净
  await shutdownCorePlugins();
});

afterEach(async () => {
  await shutdownCorePlugins();
});

describe('bootCorePlugins', () => {
  it('注册 editor / terminal / output 三个 panel 类型', () => {
    bootCorePlugins();
    const types = coApp.panels.getAll().map((p) => p.type).sort();
    expect(types).toEqual(['editor', 'output', 'terminal']);
  });

  it('每个 panel 含 title 与 factory', () => {
    bootCorePlugins();
    const all = coApp.panels.getAll();
    for (const p of all) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.factory).toBe('function');
    }
  });

  it('factory 调用返回非 null React 元素', () => {
    bootCorePlugins();
    const editor = coApp.panels.getAll().find((p) => p.type === 'editor')!;
    const node = editor.factory({} as never);
    expect(node).toBeTruthy();
  });
});

describe('shutdownCorePlugins', () => {
  it('全部反序 _deactivate,registry 清空', async () => {
    bootCorePlugins();
    expect(coApp.panels.getAll().length).toBe(3);
    await shutdownCorePlugins();
    expect(coApp.panels.getAll().length).toBe(0);
  });

  it('shutdown 二次调用幂等', async () => {
    bootCorePlugins();
    await shutdownCorePlugins();
    await expect(shutdownCorePlugins()).resolves.toBeUndefined();
  });
});

describe('PluginsTabPlugin(v3.5)', () => {
  it('boot 后注册 core.plugins 设置 tab', () => {
    bootCorePlugins();
    const tabs = coApp.settingTabs.getAll().map((t) => t.id);
    expect(tabs).toContain('core.plugins');
  });

  it('shutdown 后 tab 移除', async () => {
    bootCorePlugins();
    await shutdownCorePlugins();
    const tabs = coApp.settingTabs.getAll().map((t) => t.id);
    expect(tabs).not.toContain('core.plugins');
  });
});
