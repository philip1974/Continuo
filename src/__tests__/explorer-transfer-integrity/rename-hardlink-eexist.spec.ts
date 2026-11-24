// 改名到同 inode 的另一硬链接 → FS_EEXIST(不得误判成「改名到自身」)。
//
// 根因:renameEntry / plugin-fs:rename 只比 ino+dev 判「同一 entry」。a.txt 与 b.txt 是硬链接时
// 同 inode → 绕过 FS_EEXIST;POSIX rename 对同 inode 两链接是 no-op 却返回成功(用户以为改名了)。
// 修:仅当同 inode **且**两名字只差大小写 / Unicode 规范化(大小写不敏感盘上 File.txt→file.txt)
// 才放行,否则 FS_EEXIST。
import { link, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameEntry } from '../../../electron/main/ipc/fs/rename';
import { isCaseOrNormalizationOnlyRename } from '../../../electron/main/ipc/fs/path-utils';
import { isRenameOntoSelf } from '../../../electron/main/ipc/fs/path-utils';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rename-hardlink-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('renameEntry — 硬链接', () => {
  it('a.txt → b.txt(b.txt 是 a.txt 的硬链接)→ FS_EEXIST,两链接都保留', async () => {
    const a = path.join(dir, 'a.txt');
    await writeFile(a, 'AAA');
    await link(a, path.join(dir, 'b.txt'));

    await expect(renameEntry(a, 'b.txt')).rejects.toMatchObject({ code: 'FS_EEXIST' });
    expect((await readdir(dir)).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('改回同名(同 inode 且名字相同)→ 仍放行', async () => {
    const a = path.join(dir, 'a.txt');
    await writeFile(a, 'AAA');
    await expect(renameEntry(a, 'a.txt')).resolves.toBe(a);
  });
});

describe('isCaseOrNormalizationOnlyRename', () => {
  it('仅大小写不同 → true', () => {
    expect(isCaseOrNormalizationOnlyRename('/d/File.txt', '/d/file.txt')).toBe(true);
  });
  it('仅 Unicode 规范化不同(NFD é vs NFC é)→ true', () => {
    expect(isCaseOrNormalizationOnlyRename('/d/e\u0301.txt', '/d/\u00e9.txt')).toBe(true);
  });
  it('不同名字 → false', () => {
    expect(isCaseOrNormalizationOnlyRename('/d/a.txt', '/d/b.txt')).toBe(false);
  });
});

describe('isCaseOrNormalizationOnlyRename — 只比 basename', () => {
  // 两个调用方(renameEntry / plugin-fs:rename)都已保证同父目录;父目录表示差异(如 macOS
  // realpath 后的 /private/var vs /var)不应影响判断。
  it('父目录表示不同但 basename 仅大小写不同 → true', async () => {
    const canonical = await realpath(dir);
    expect(isCaseOrNormalizationOnlyRename(path.join(canonical, 'A'), path.join(dir, 'a'))).toBe(
      true,
    );
  });
});

// Explorer 改名与插件 fs.rename 共用的「改名到自身」判定(此前两份手写)。
describe('isRenameOntoSelf', () => {
  const st = (ino: number, dev = 1) => ({ ino, dev });
  it('同 dev+inode 且名字只差大小写 / 规范化 → true', () => {
    expect(isRenameOntoSelf(st(5), st(5), '/d/File.txt', '/d/file.txt')).toBe(true);
  });
  it('同 inode 的不同硬链接(名字不同)/ inode 不同 / dev 不同 / 源 stat 缺失 → false', () => {
    expect(isRenameOntoSelf(st(5), st(5), '/d/a.txt', '/d/b.txt')).toBe(false);
    expect(isRenameOntoSelf(st(5), st(6), '/d/File.txt', '/d/file.txt')).toBe(false);
    expect(isRenameOntoSelf(st(5, 1), st(5, 2), '/d/File.txt', '/d/file.txt')).toBe(false);
    expect(isRenameOntoSelf(null, st(5), '/d/File.txt', '/d/file.txt')).toBe(false);
  });
});

