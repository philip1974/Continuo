import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listPluginDirs,
  readEnabledIds,
  readPermissions,
  resolvePluginMainPath,
  uninstallPlugin,
  writeEnabledIds,
  writePermissions,
} from '../../../electron/main/services/plugins.service';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lm-plugins-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeDir(id: string, manifest: object, mainText = '/* main */', stylesText?: string) {
  const dir = join(tmp, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'main.js'), mainText);
  if (stylesText !== undefined) writeFileSync(join(dir, 'styles.css'), stylesText);
}

describe('listPluginDirs', () => {
  it('baseDir 不存在 → []', async () => {
    expect(await listPluginDirs(join(tmp, 'nope'))).toEqual([]);
  });

  it('空 baseDir → []', async () => {
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('收 manifest+main.js 完整目录', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    const r = await listPluginDirs(tmp);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('com.foo');
    expect(r[0]!.manifestText).toContain('"id":"com.foo"');
    expect(r[0]!.mainText).toBe('/* main */');
    expect(r[0]!.stylesText).toBeUndefined();
  });

  it('含 styles.css → stylesText 透传', async () => {
    makeDir(
      'com.bar',
      { id: 'com.bar', name: 'Bar', version: '0.1.0' },
      '/* main */',
      '.foo{}',
    );
    const r = await listPluginDirs(tmp);
    expect(r[0]!.stylesText).toBe('.foo{}');
  });

  it('缺 manifest.json → 跳过', async () => {
    const dir = join(tmp, 'nomanifest');
    mkdirSync(dir);
    writeFileSync(join(dir, 'main.js'), '/* */');
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('缺 main.js → 跳过', async () => {
    const dir = join(tmp, 'nomain');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id: 'x', name: 'X', version: '0.1.0' }),
    );
    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('manifest.main 自定义入口', async () => {
    const dir = join(tmp, 'custom');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'custom',
        name: 'X',
        version: '0.1.0',
        main: 'index.js',
      }),
    );
    writeFileSync(join(dir, 'index.js'), 'CUSTOM');
    const r = await listPluginDirs(tmp);
    expect(r[0]!.mainText).toBe('CUSTOM');
  });

  it('manifest.main 允许插件目录内的子目录入口', async () => {
    const dir = join(tmp, 'nested-main');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'nested-main',
        name: 'X',
        version: '0.1.0',
        main: 'dist/index.js',
      }),
    );
    writeFileSync(join(dir, 'dist', 'index.js'), 'NESTED');

    const r = await listPluginDirs(tmp);
    expect(r[0]!.mainText).toBe('NESTED');
  });

  it('manifest.main 含 .. 时跳过插件,不读取目录外文件', async () => {
    const dir = join(tmp, 'escape');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'escape',
        name: 'X',
        version: '0.1.0',
        main: '../outside.js',
      }),
    );
    writeFileSync(join(tmp, 'outside.js'), 'OUTSIDE');

    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('manifest.main 是绝对路径时跳过插件', async () => {
    const dir = join(tmp, 'absolute');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'absolute',
        name: 'X',
        version: '0.1.0',
        main: join(tmp, 'outside.js'),
      }),
    );
    writeFileSync(join(tmp, 'outside.js'), 'OUTSIDE');

    expect(await listPluginDirs(tmp)).toEqual([]);
  });

  it('resolvePluginMainPath 只返回插件目录内路径', () => {
    const dir = join(tmp, 'safe');
    expect(resolvePluginMainPath(dir, 'dist/index.js')).toBe(
      join(dir, 'dist', 'index.js'),
    );
    expect(resolvePluginMainPath(dir, '../outside.js')).toBeNull();
    expect(resolvePluginMainPath(dir, '/tmp/outside.js')).toBeNull();
    expect(resolvePluginMainPath(dir, String.raw`C:\tmp\outside.js`)).toBeNull();
  });

  it('忽略 . / _ 开头的目录', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    mkdirSync(join(tmp, '.git'));
    mkdirSync(join(tmp, '_internal'));
    writeFileSync(join(tmp, '_enabled.json'), '[]');
    const r = await listPluginDirs(tmp);
    expect(r.map((x) => x.id)).toEqual(['com.foo']);
  });

  it('普通文件不视为目录', async () => {
    writeFileSync(join(tmp, 'README.md'), '# hi');
    expect(await listPluginDirs(tmp)).toEqual([]);
  });
});

describe('readEnabledIds / writeEnabledIds', () => {
  it('未写过 → []', async () => {
    expect(await readEnabledIds(tmp)).toEqual([]);
  });

  it('write + read 往返', async () => {
    await writeEnabledIds(tmp, ['a', 'b']);
    expect(await readEnabledIds(tmp)).toEqual(['a', 'b']);
  });

  it('文件含非 string → 返 []', async () => {
    writeFileSync(join(tmp, '_enabled.json'), JSON.stringify(['ok', 1]));
    expect(await readEnabledIds(tmp)).toEqual([]);
  });

  it('文件 JSON 损坏 → 返 []', async () => {
    writeFileSync(join(tmp, '_enabled.json'), '{{{');
    expect(await readEnabledIds(tmp)).toEqual([]);
  });

  it('write 时自动 mkdir -p', async () => {
    const sub = join(tmp, 'nested', 'plugins');
    await writeEnabledIds(sub, ['x']);
    expect(await readEnabledIds(sub)).toEqual(['x']);
  });
});

// ── v4.2 权限决策持久化 ─────────────────────────────────

describe('readPermissions / writePermissions', () => {
  it('未写过 → {}', async () => {
    expect(await readPermissions(tmp)).toEqual({});
  });

  it('write + read 往返(多 plugin 多 decision)', async () => {
    await writePermissions(tmp, {
      'p.a': [
        { permission: 'fs', granted: true, decidedAt: 1000 },
        { permission: 'network', granted: false, decidedAt: 1100 },
      ],
      'p.b': [{ permission: 'shell', granted: true, decidedAt: 2000 }],
    });
    const r = await readPermissions(tmp);
    // M6:IpcPermissionsMap 现为 union(数组 | {decisions,pathScopes});readPermissions
    // 运行时只返数组形态,测试用 Array.isArray 窄化后再索引。
    const pa = r['p.a'];
    const pb = r['p.b'];
    if (!Array.isArray(pa) || !Array.isArray(pb)) throw new Error('expected array shape');
    expect(pa).toHaveLength(2);
    expect(pb).toHaveLength(1);
    expect(pa[0]!.permission).toBe('fs');
  });

  it('JSON 损坏 → {}', async () => {
    writeFileSync(join(tmp, '_permissions.json'), '{{{');
    expect(await readPermissions(tmp)).toEqual({});
  });

  it('顶层非 object(数组)→ {}', async () => {
    writeFileSync(join(tmp, '_permissions.json'), '[]');
    expect(await readPermissions(tmp)).toEqual({});
  });

  it('value 含非 decision 形状的项 → 该 pluginId 跳过', async () => {
    writeFileSync(
      join(tmp, '_permissions.json'),
      JSON.stringify({
        good: [{ permission: 'fs', granted: true, decidedAt: 1 }],
        bad: [{ permission: 'fs' /* missing granted */ }],
      }),
    );
    const r = await readPermissions(tmp);
    expect(r.good).toHaveLength(1);
    expect(r.bad).toBeUndefined();
  });

  it('write 时自动 mkdir -p', async () => {
    const sub = join(tmp, 'deep', 'plugins');
    await writePermissions(sub, {
      'p.x': [{ permission: 'fs', granted: true, decidedAt: 1 }],
    });
    expect((await readPermissions(sub))['p.x']).toHaveLength(1);
  });
});

// ── v4.6 卸载 ──────────────────────────────────────────

describe('uninstallPlugin', () => {
  it('id 含非法字符 → INVALID_ID,不动文件系统', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    await expect(uninstallPlugin(tmp, '../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_ID',
    });
    // 既有目录没被影响
    expect(await listPluginDirs(tmp)).toHaveLength(1);
  });

  it('插件目录不存在 → NOT_INSTALLED', async () => {
    await expect(uninstallPlugin(tmp, 'com.notexist')).rejects.toMatchObject({
      code: 'NOT_INSTALLED',
    });
  });

  it('正常路径:删目录 + 从 _enabled.json 摘 id', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    makeDir('com.bar', { id: 'com.bar', name: 'Bar', version: '0.1.0' });
    await writeEnabledIds(tmp, ['com.foo', 'com.bar']);

    await uninstallPlugin(tmp, 'com.foo');

    expect((await listPluginDirs(tmp)).map((x) => x.id)).toEqual(['com.bar']);
    expect(await readEnabledIds(tmp)).toEqual(['com.bar']);
  });

  it('正常路径:从 _permissions.json 摘 id', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    await writePermissions(tmp, {
      'com.foo': [{ permission: 'fs', granted: true, decidedAt: 1 }],
      'com.bar': [{ permission: 'network', granted: true, decidedAt: 2 }],
    });

    await uninstallPlugin(tmp, 'com.foo');

    const perms = await readPermissions(tmp);
    expect(perms['com.foo']).toBeUndefined();
    expect(perms['com.bar']).toHaveLength(1);
  });

  it('id 不在 _enabled / _permissions 中 → 不报错,只删目录', async () => {
    makeDir('com.foo', { id: 'com.foo', name: 'Foo', version: '0.1.0' });
    await writeEnabledIds(tmp, ['com.bar']); // foo 不在内
    await uninstallPlugin(tmp, 'com.foo');
    expect(await listPluginDirs(tmp)).toEqual([]);
    expect(await readEnabledIds(tmp)).toEqual(['com.bar']);
  });
});
