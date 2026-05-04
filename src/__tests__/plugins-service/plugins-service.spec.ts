import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listPluginDirs,
  readEnabledIds,
  writeEnabledIds,
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
