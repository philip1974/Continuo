// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { lmApp } from '../../plugins/lm-app';

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
    const types = lmApp.panels.getAll().map((p) => p.type).sort();
    expect(types).toEqual(['editor', 'output', 'terminal']);
  });

  it('每个 panel 含 title 与 factory', () => {
    bootCorePlugins();
    const all = lmApp.panels.getAll();
    for (const p of all) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.factory).toBe('function');
    }
  });

  it('factory 调用返回非 null React 元素', () => {
    bootCorePlugins();
    const editor = lmApp.panels.getAll().find((p) => p.type === 'editor')!;
    const node = editor.factory({} as never);
    expect(node).toBeTruthy();
  });
});

describe('shutdownCorePlugins', () => {
  it('全部反序 _deactivate,registry 清空', async () => {
    bootCorePlugins();
    expect(lmApp.panels.getAll().length).toBe(3);
    await shutdownCorePlugins();
    expect(lmApp.panels.getAll().length).toBe(0);
  });

  it('shutdown 二次调用幂等', async () => {
    bootCorePlugins();
    await shutdownCorePlugins();
    await expect(shutdownCorePlugins()).resolves.toBeUndefined();
  });
});
