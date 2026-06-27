// 数据安全(codex 复查 P1):编辑器打开 symlink 文件时 fs.readFile 跟随到 target 内容,
// 保存(atomicWriteFile)也必须写到 target —— 否则 sibling tmp + rename(tmp, link) 会用
// 普通文件替换链接本身,target 未更新,用户编辑落在断链副本里(读/写语义不对称)。
// 与 plugin-fs 的 rm/lstat/rename「实体操作不跟随 symlink」区分:内容读/写应对称跟随。

import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-aw-symlink-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('atomicWriteFile 保存 symlink 写穿到 target,不断链', () => {
  it('保存 symlink 路径 → target 内容更新,链接保留', async () => {
    const dir = await tempDir();
    const target = join(dir, 'target.txt');
    const link = join(dir, 'link.txt');
    await writeFile(target, 'original', 'utf-8');
    await symlink(target, link);

    await atomicWriteFile(link, 'edited');

    // 链接仍是 symlink(未被普通文件替换断链)
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    // target 内容已更新(写穿到目标)
    expect(await readFile(target, 'utf-8')).toBe('edited');
    // 经链接读取也是新内容(读/写对称)
    expect(await readFile(link, 'utf-8')).toBe('edited');
  });

  it('普通文件路径不受影响', async () => {
    const dir = await tempDir();
    const file = join(dir, 'plain.txt');
    await atomicWriteFile(file, 'hello');
    expect(await readFile(file, 'utf-8')).toBe('hello');
  });
});
