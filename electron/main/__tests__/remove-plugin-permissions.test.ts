import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPermissions, removePluginPermissions } from '../services/plugins.service';

// 卸载时清 `_permissions.json` 里该插件的条目:main 端串行 read-modify-write,只动该 id。
// (授权决策的写入走 mutatePluginPermissions,见 src/__tests__/ipc-permission-store 等。)
describe('removePluginPermissions(单 plugin 串行删除)', () => {
  let baseDir: string;
  let permFile: string;
  const decision = (decidedAt: number) => ({ permission: 'fs', granted: true, decidedAt });

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'continuo-perms-'));
    permFile = path.join(baseDir, '_permissions.json');
  });
  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('删除该 id,保留其它 plugin 的记录', async () => {
    await writeFile(permFile, JSON.stringify({ 'p.a': [decision(1)], 'p.b': [decision(2)] }));

    await removePluginPermissions(baseDir, 'p.a');

    const all = await readPermissions(baseDir);
    expect(all['p.a']).toBeUndefined();
    expect(all['p.b']).toEqual([decision(2)]);
  });

  it('并发删除不同 plugin → 串行化,互不覆盖', async () => {
    await writeFile(
      permFile,
      JSON.stringify({ 'p.a': [decision(1)], 'p.b': [decision(2)], 'p.c': [decision(3)] }),
    );

    await Promise.all([
      removePluginPermissions(baseDir, 'p.a'),
      removePluginPermissions(baseDir, 'p.b'),
    ]);

    expect(Object.keys(await readPermissions(baseDir))).toEqual(['p.c']);
  });

  it('条目不存在 → 不触盘', async () => {
    await writeFile(permFile, JSON.stringify({ 'p.b': [decision(2)] }));
    const before = await stat(permFile);
    const raw = await readFile(permFile, 'utf-8');

    await removePluginPermissions(baseDir, 'p.a');

    expect(await readFile(permFile, 'utf-8')).toBe(raw);
    expect((await stat(permFile)).ino).toBe(before.ino);
  });

  it('文件不存在 / 非法 id → 忽略,不创建文件', async () => {
    await removePluginPermissions(baseDir, 'p.a');
    await removePluginPermissions(baseDir, '../evil');

    await expect(stat(permFile)).rejects.toThrow();
  });
});
