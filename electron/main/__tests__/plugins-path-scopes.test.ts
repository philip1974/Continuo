import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPluginPathScopes,
  writePluginPathScopes,
} from '../services/plugins.service';

const SCOPES_FILE = '_plugin-path-scopes.json';
const tempRoots: string[] = [];

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'continuo-pathscopes-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('plugins.service path-scope persistence', () => {
  it('P1 缺文件时读回空数组', async () => {
    const base = await makeBaseDir();
    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([]);
  });

  it('P2 写入后可读回(round-trip)', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, 'com.a', [
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/b', mode: 'r' },
    ]);
    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/b', mode: 'r' },
    ]);
  });

  it('P3 不同 plugin 互不干扰', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, 'com.a', [{ path: '/ws/a', mode: 'rw' }]);
    await writePluginPathScopes(base, 'com.b', [{ path: '/ws/b', mode: 'r' }]);

    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([
      { path: '/ws/a', mode: 'rw' },
    ]);
    await expect(readPluginPathScopes(base, 'com.b')).resolves.toEqual([
      { path: '/ws/b', mode: 'r' },
    ]);
  });

  it('P4 覆盖式写入:再次写入替换该 plugin 全集', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, 'com.a', [{ path: '/ws/a', mode: 'r' }]);
    await writePluginPathScopes(base, 'com.a', [
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/c', mode: 'rw' },
    ]);
    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([
      { path: '/ws/a', mode: 'rw' },
      { path: '/ws/c', mode: 'rw' },
    ]);
  });

  it('P5 空数组写入删除该 id,不影响其它 plugin', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, 'com.a', [{ path: '/ws/a', mode: 'rw' }]);
    await writePluginPathScopes(base, 'com.b', [{ path: '/ws/b', mode: 'rw' }]);

    await writePluginPathScopes(base, 'com.a', []);

    await expect(readPluginPathScopes(base, 'com.a')).resolves.toEqual([]);
    await expect(readPluginPathScopes(base, 'com.b')).resolves.toEqual([
      { path: '/ws/b', mode: 'rw' },
    ]);
  });

  it('P6 非法 id 被忽略,不写出畸形 key', async () => {
    const base = await makeBaseDir();
    await writePluginPathScopes(base, '../evil', [{ path: '/ws/a', mode: 'rw' }]);
    // 文件要么不存在(从未写),要么不含该 key
    let raw = '{}';
    try {
      raw = await readFile(join(base, SCOPES_FILE), 'utf-8');
    } catch {
      // 没创建文件也是可接受的(从未触盘)
    }
    expect(raw).not.toContain('evil');
  });

  it('P7 读取时丢弃畸形条目(非数组 / 缺字段 / 非法 mode)', async () => {
    const base = await makeBaseDir();
    await writeFile(
      join(base, SCOPES_FILE),
      JSON.stringify({
        'com.ok': [{ path: '/ws/a', mode: 'rw' }],
        'com.notarray': { path: '/ws/x', mode: 'r' },
        'com.badmode': [{ path: '/ws/y', mode: 'x' }],
        'com.missing': [{ mode: 'r' }],
      }),
      'utf-8',
    );

    await expect(readPluginPathScopes(base, 'com.ok')).resolves.toEqual([
      { path: '/ws/a', mode: 'rw' },
    ]);
    await expect(readPluginPathScopes(base, 'com.notarray')).resolves.toEqual([]);
    await expect(readPluginPathScopes(base, 'com.badmode')).resolves.toEqual([]);
    await expect(readPluginPathScopes(base, 'com.missing')).resolves.toEqual([]);
  });
});
