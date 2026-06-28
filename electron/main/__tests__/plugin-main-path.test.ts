import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { resolvePluginMainPath } from '../services/plugins.service';

describe('resolvePluginMainPath', () => {
  it('解析插件 main 相对路径并拒绝路径穿越', () => {
    const root = path.resolve('/tmp/continuo-plugin');

    expect(resolvePluginMainPath(root, 'main.js')).toBe(
      path.join(root, 'main.js'),
    );
    expect(resolvePluginMainPath(root, 'dist/main.js')).toBe(
      path.join(root, 'dist/main.js'),
    );
    expect(resolvePluginMainPath(root, '../evil.js')).toBeNull();
    expect(resolvePluginMainPath(root, 'dist/../evil.js')).toBeNull();
    expect(resolvePluginMainPath(root, '/tmp/evil.js')).toBeNull();
  });

  it('检测点点路径段不通过 split 物化全部片段', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(resolvePluginMainPath('/tmp/plugin', 'dist/main.js')).toBe(
        path.resolve('/tmp/plugin/dist/main.js'),
      );
      expect(resolvePluginMainPath('/tmp/plugin', 'dist/../main.js')).toBeNull();
      expect(
        splitSpy.mock.contexts.some(
          (ctx) =>
            String(ctx) === 'dist/main.js' || String(ctx) === 'dist/../main.js',
        ),
      ).toBe(false);
    } finally {
      splitSpy.mockRestore();
    }
  });

  it('Windows 盘符绝对路径判断不调用 RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      expect(resolvePluginMainPath('/tmp/plugin', 'C:\\evil\\main.js')).toBeNull();
      const windowsPathRegexCalls = testSpy.mock.contexts.filter(
        (context) => context instanceof RegExp && context.source === '^[a-zA-Z]:[\\\\/]',
      );
      expect(windowsPathRegexCalls).toHaveLength(0);
    } finally {
      testSpy.mockRestore();
    }
  });
});
