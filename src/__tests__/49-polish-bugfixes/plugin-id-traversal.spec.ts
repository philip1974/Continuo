import { describe, expect, it, vi } from 'vitest';
import { isSafePluginId } from '../../../electron/main/services/plugins.service';
import { isValidPluginId } from '../../plugins/plugin-id';

// P1 安全回归:旧正则 `^[a-z0-9._-]+$` 允许纯点段,manifest.id='..' 通过校验 →
// path.join(baseDir,'..') 解析到 baseDir 父目录,overwrite 安装(marketplace「更新」)
// rename 覆盖父目录 = 路径穿越。isSafePluginId 显式拒 `.`/`..`。
describe('49 · isSafePluginId 拒绝路径穿越 id', () => {
  it('拒绝 `..`(父目录穿越)', () => {
    expect(isSafePluginId('..')).toBe(false);
  });

  it('拒绝 `.`(指向 baseDir 自身)', () => {
    expect(isSafePluginId('.')).toBe(false);
  });

  it('接受正常 id', () => {
    expect(isSafePluginId('git-changes-viewer')).toBe(true);
    expect(isSafePluginId('my.plugin_v2-beta')).toBe(true);
    expect(isSafePluginId('a')).toBe(true);
  });

  it('接受含点但非纯点的 id(非穿越)', () => {
    expect(isSafePluginId('...')).toBe(true); // join 后是普通子目录,非穿越
    expect(isSafePluginId('a.b')).toBe(true);
  });

  it('拒绝含分隔符 / 大写 / 空白 / 空串', () => {
    expect(isSafePluginId('foo/bar')).toBe(false);
    expect(isSafePluginId('..\\evil')).toBe(false);
    expect(isSafePluginId('Foo')).toBe(false);
    expect(isSafePluginId('a b')).toBe(false);
    expect(isSafePluginId('')).toBe(false);
  });

  it('main/renderer plugin id 校验不调用 RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      expect(isSafePluginId('my.plugin_v2-beta')).toBe(true);
      expect(isSafePluginId('BadId')).toBe(false);
      expect(isValidPluginId('my.plugin_v2-beta')).toBe(true);
      expect(isValidPluginId('BadId')).toBe(false);
      const pluginIdRegexCalls = testSpy.mock.contexts.filter(
        (context) => context instanceof RegExp && context.source === '^[a-z0-9._-]+$',
      );
      expect(pluginIdRegexCalls).toHaveLength(0);
    } finally {
      testSpy.mockRestore();
    }
  });
});
