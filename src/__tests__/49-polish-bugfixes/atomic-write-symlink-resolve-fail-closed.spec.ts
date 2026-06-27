// 数据安全(codex 复查 P1,#11 的连带缺口):atomicWriteFile 的 symlink 写穿解析
// (resolveSymlinkTarget)此前用 catch-all 吞掉 lstat/realpath 的所有错误并回退原路径。
// lstat 确认 leaf 是 symlink 后,realpath 若 EACCES/EIO 失败 → 回退原路径 → rename 用普通
// 文件替换 symlink 本身(断链、读写不对称),重现 #11 修过的损坏。修复:只对 ENOENT 回退,
// 其它 lstat/realpath 错误抛出中止保存。

import { vi } from 'vitest';

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, realpath: vi.fn(real.realpath) };
});

import {
  realpath,
  lstat as realLstatExport,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';

const realRealpath = (
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
).realpath;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aw-symlink-resolve-'));
  (realpath as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    realRealpath,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  (realpath as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    realRealpath,
  );
  await rm(dir, { recursive: true, force: true });
});

describe('atomicWriteFile symlink 解析 fail-closed', () => {
  it('symlink 的 realpath EACCES → 抛,不回退断链替换链接', async () => {
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    await writeFile(target, 'original', 'utf-8');
    await symlink(target, link);

    (realpath as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (p: Parameters<typeof realRealpath>[0]) => {
        if (String(p) === link) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return realRealpath(p);
      },
    );

    await expect(atomicWriteFile(link, 'edited')).rejects.toThrow();
    // link 仍是 symlink(未被普通文件替换断链)
    expect((await realLstatExport(link)).isSymbolicLink()).toBe(true);
  });
});
