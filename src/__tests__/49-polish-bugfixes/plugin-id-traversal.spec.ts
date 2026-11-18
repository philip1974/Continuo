import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSafePluginId,
  listPluginDirs,
  uninstallPlugin,
} from '../../../electron/main/services/plugins.service';
import { parseManifest } from '../../../electron/shared/plugin-manifest';
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

  it('接受中间含点 / 下划线 / 连字符的 id', () => {
    expect(isSafePluginId('a.b')).toBe(true);
    expect(isSafePluginId('a_b-c.d')).toBe(true);
    expect(isSafePluginId('0x')).toBe(true);
  });

  it('拒绝 . / _ 开头的 id(plugins 目录元数据与临时目录命名空间,列举逻辑跳过)', () => {
    for (const id of ['...', '_plugin-path-scopes.json', '_permissions.json', '.victim.old-1', '_', '.']) {
      expect(isSafePluginId(id)).toBe(false);
      expect(isValidPluginId(id)).toBe(false);
    }
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

// 回归:`-` 开头的 id 此前一直合法。首字符收紧若连 `-` 一并拒,已装的这类插件被 renderer
// parseManifest 静默跳过(UI 不可见)、卸载又报 INVALID_ID → 目录永久残留。`-` 不属 . / _ 元数据命名空间,保留放行。
describe('49 · `-` 开头的已装插件仍可见、可卸载', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('id 校验与 manifest 解析放行 `-` 开头', () => {
    expect(isSafePluginId('-legacy')).toBe(true);
    expect(isValidPluginId('-legacy')).toBe(true);
    const parsed = parseManifest(
      JSON.stringify({ id: '-legacy', name: 'Legacy', version: '1.0.0' }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('列举可见、卸载成功删除目录', async () => {
    const base = mkdtempSync(join(tmpdir(), 'continuo-dash-id-'));
    roots.push(base);
    mkdirSync(join(base, '-legacy'));
    writeFileSync(
      join(base, '-legacy', 'manifest.json'),
      JSON.stringify({ id: '-legacy', name: 'Legacy', version: '1.0.0' }),
    );
    writeFileSync(join(base, '-legacy', 'main.js'), 'module.exports = {};');
    const listed = await listPluginDirs(base);
    expect(listed.map((d) => d.id)).toEqual(['-legacy']);
    await uninstallPlugin(base, '-legacy');
    expect(existsSync(join(base, '-legacy'))).toBe(false);
  });
});
