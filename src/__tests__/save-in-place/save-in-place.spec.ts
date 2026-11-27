// BDD: 编辑器保存覆盖已有文件 → 原地写(同一 inode),硬链接 / 扩展属性 / 权限位 / 符号链接 / 创建时间保持;
// 只读目录里的可写文件可保存。行为见同目录 README。被测:electron/main/ipc/fs/atomic-write.ts atomicWriteFile。
import { execFileSync } from 'node:child_process';
import { chmod, link, lstat, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';
import { setupTempDirs } from '../_helpers/tmp-dir';

const tmp = setupTempDirs();
const posix = process.platform !== 'win32';
const darwin = process.platform === 'darwin';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function fileWith(content: string, name = 'doc.md'): Promise<string> {
  const f = join(await tmp.make('continuo-inplace-'), name);
  await writeFile(f, content);
  return f;
}

describe('编辑器保存已有文件:原地写', () => {
  it('同一 inode,内容更新;变长 / 变短都正确,目录里不留 tmp', async () => {
    const f = await fileWith('0123456789');
    const ino = (await stat(f)).ino;
    await atomicWriteFile(f, 'short');
    expect(await readFile(f, 'utf-8')).toBe('short');
    await atomicWriteFile(f, 'a much longer content than before');
    expect(await readFile(f, 'utf-8')).toBe('a much longer content than before');
    await atomicWriteFile(f, '');
    expect(await readFile(f, 'utf-8')).toBe('');
    await atomicWriteFile(f, new Uint8Array([1, 2, 3]));
    expect([...(await readFile(f))]).toEqual([1, 2, 3]);
    expect((await stat(f)).ino).toBe(ino);
    expect((await readdir(join(f, '..'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(!posix)('硬链接不被拆开:另一个名字同样看到新内容', async () => {
    const f = await fileWith('OLD');
    const other = join(f, '..', 'other-name.md');
    await link(f, other);
    await atomicWriteFile(f, 'NEW');
    expect(await readFile(other, 'utf-8')).toBe('NEW');
    expect((await stat(f)).ino).toBe((await stat(other)).ino);
    expect((await stat(f)).nlink).toBe(2);
  });

  it.skipIf(!darwin)('扩展属性(Finder 标签 / user.note)保存后仍在', async () => {
    const f = await fileWith('OLD');
    execFileSync('xattr', ['-w', 'user.note', 'keep me', f]);
    execFileSync('xattr', ['-w', 'com.apple.metadata:_kMDItemUserTags', '("Red\n6")', f]);
    await atomicWriteFile(f, 'NEW');
    expect(execFileSync('xattr', ['-p', 'user.note', f], { encoding: 'utf-8' }).trim()).toBe('keep me');
    expect(execFileSync('xattr', ['-p', 'com.apple.metadata:_kMDItemUserTags', f], { encoding: 'utf-8' })).toContain(
      'Red',
    );
  });

  it.skipIf(!darwin)('创建时间不变', async () => {
    const f = await fileWith('OLD');
    const past = new Date('2020-01-02T03:04:05Z');
    await utimes(f, past, past); // macOS:mtime 早于 birthtime 时 birthtime 跟着回拨
    const born = (await stat(f)).birthtimeMs;
    await atomicWriteFile(f, 'NEW');
    expect((await stat(f)).birthtimeMs).toBe(born);
  });

  it.skipIf(!posix)('权限位(0755 脚本)保持', async () => {
    const f = await fileWith('#!/bin/sh\n', 'run.sh');
    await chmod(f, 0o755);
    await atomicWriteFile(f, '#!/bin/sh\necho hi\n');
    expect((await stat(f)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(!posix)('符号链接:写到目标,链接仍是链接,目标 inode 不变', async () => {
    const target = await fileWith('original', 'target.md');
    const linkPath = join(target, '..', 'link.md');
    await symlink(target, linkPath);
    const ino = (await stat(target)).ino;
    await atomicWriteFile(linkPath, 'edited');
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe('edited');
    expect((await stat(target)).ino).toBe(ino);
  });

  it.skipIf(!posix || isRoot)('只读目录(555)里的可写文件(644)可以保存', async () => {
    const f = await fileWith('OLD');
    const dir = join(f, '..');
    await chmod(dir, 0o555);
    try {
      await atomicWriteFile(f, 'NEW');
      expect(await readFile(f, 'utf-8')).toBe('NEW');
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('返回写入内容的身份,与磁盘 stat 一致', async () => {
    const f = await fileWith('OLD');
    const r = await atomicWriteFile(f, 'NEW!');
    const st = await stat(f);
    if (process.platform === 'win32') return; // NTFS 关闭写句柄刷新 mtime → 可能 undefined(保守)
    expect(r).toEqual({ mtimeMs: st.mtimeMs, size: 4, ino: st.ino });
  });

  it('新建文件仍可创建(tmp + rename 路径)', async () => {
    const dir = await tmp.make('continuo-inplace-');
    await atomicWriteFile(join(dir, 'fresh.md'), 'hello');
    expect(await readFile(join(dir, 'fresh.md'), 'utf-8')).toBe('hello');
  });
});
