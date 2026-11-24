import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isSafePluginId,
  listPluginDirs,
  uninstallPlugin,
} from '../../../electron/main/services/plugins.service';
import { parseManifest } from '../../../electron/shared/plugin-manifest';
import { isValidPluginId } from '../../plugins/plugin-id';
import { setupTempDirs } from '../_helpers/tmp-dir';

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
  const tmp = setupTempDirs();

  it('id 校验与 manifest 解析放行 `-` 开头', () => {
    expect(isSafePluginId('-legacy')).toBe(true);
    expect(isValidPluginId('-legacy')).toBe(true);
    const parsed = parseManifest(
      JSON.stringify({ id: '-legacy', name: 'Legacy', version: '1.0.0' }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('列举可见、卸载成功删除目录', async () => {
    const base = tmp.makeSync('continuo-dash-id-');
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

// 安全(Windows):Win32 会去掉路径段尾部的点,`foo.` 与 `foo` 落到同一个安装目录与 data 文件,而互斥锁 /
// 权限 / scope 的键仍是两个 id;保留设备名(con / nul / com1 …,含带扩展名形式)作目录名时指向设备而非目录。
// 各平台统一拒绝(同一份 manifest 不因平台而异)。
describe('49 · id 不得以 `.` 结尾,也不得是 Windows 保留设备名', () => {
  const rejected = [
    'foo.',
    'com.example.',
    'a..',
    'con',
    'prn',
    'aux',
    'nul',
    'com0',
    'com1',
    'com9',
    'lpt0',
    'lpt1',
    'lpt9',
    'nul.x',
    'con.example.foo',
    'aux.tar.gz',
    'com1.plugin',
  ];
  const accepted = [
    'com.continuo.skills-manager',
    'continuo-git-changes-viewer',
    'com.example.foo',
    'console',
    'null',
    'nul-x',
    'nul_x',
    'x.nul',
    'my.con',
    'com',
    'lpt',
    'com10',
    'com1x',
    'auxiliary.tools',
    'a.b-',
    'a_',
  ];

  it.each(rejected)('拒绝 %s(校验函数与 manifest 解析一致)', (id) => {
    expect(isValidPluginId(id)).toBe(false);
    expect(isSafePluginId(id)).toBe(false);
    expect(parseManifest(JSON.stringify({ id, name: 'P', version: '1.0.0' })).ok).toBe(false);
  });

  it.each(accepted)('放行 %s', (id) => {
    expect(isValidPluginId(id)).toBe(true);
    expect(isSafePluginId(id)).toBe(true);
    expect(parseManifest(JSON.stringify({ id, name: 'P', version: '1.0.0' })).ok).toBe(true);
  });

  it('卸载尾点 id 报 INVALID_ID,不碰去掉尾点后同名的正常插件目录', async () => {
    const base = mkdtempSync(join(tmpdir(), 'continuo-dot-id-'));
    try {
      mkdirSync(join(base, 'foo'));
      writeFileSync(
        join(base, 'foo', 'manifest.json'),
        JSON.stringify({ id: 'foo', name: 'Foo', version: '1.0.0' }),
      );
      await expect(uninstallPlugin(base, 'foo.')).rejects.toMatchObject({ code: 'INVALID_ID' });
      expect(existsSync(join(base, 'foo', 'manifest.json'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
