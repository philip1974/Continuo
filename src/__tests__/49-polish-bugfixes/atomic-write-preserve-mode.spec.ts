// 数据安全(独立审计):atomicWriteFile 以 `open(tmp,'wx')` 新建临时文件(权限 0666&umask)再 rename
// 覆盖原文件 → 原文件的 POSIX 权限位被重置:`chmod 755 run.sh` 后经 Continuo 保存丢执行位(0644),
// 0600 私密文件被放宽成 0644。修复(参考 VSCode / 多数编辑器):覆盖已有普通文件时临时文件在 rename
// 前继承原文件 `mode & 0o777`(不保留 setuid/setgid/sticky);新建文件行为不变。Windows mode 语义有限,
// 跳过断言。

import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';
import { setupTempDirs } from '../_helpers/tmp-dir';

async function tempDir(): Promise<string> {
  const d = await tmp.make('continuo-aw-mode-');
  return d;
}
const tmp = setupTempDirs();

describe.skipIf(process.platform === 'win32')('atomicWriteFile 覆盖保存保留原文件权限位', () => {
  it('0755 可执行脚本保存后仍为 0755', async () => {
    const f = join(await tempDir(), 'run.sh');
    await writeFile(f, '#!/bin/sh\necho a\n');
    await chmod(f, 0o755);

    await atomicWriteFile(f, '#!/bin/sh\necho b\n');

    expect((await stat(f)).mode & 0o777).toBe(0o755);
    expect(await readFile(f, 'utf-8')).toBe('#!/bin/sh\necho b\n');
  });

  it('0600 私密文件保存后仍为 0600(不被放宽)', async () => {
    const f = join(await tempDir(), 'secret.env');
    await writeFile(f, 'A=1');
    await chmod(f, 0o600);

    await atomicWriteFile(f, 'A=2');

    expect((await stat(f)).mode & 0o777).toBe(0o600);
  });

  it('二进制写同样保留权限', async () => {
    const f = join(await tempDir(), 'bin.dat');
    await writeFile(f, 'x');
    await chmod(f, 0o750);

    await atomicWriteFile(f, new Uint8Array([1, 2, 3]));

    expect((await stat(f)).mode & 0o777).toBe(0o750);
  });

  it('新建文件行为不变(0666 & ~umask)', async () => {
    const f = join(await tempDir(), 'new.txt');
    await atomicWriteFile(f, 'hello');
    const umask = process.umask();
    expect((await stat(f)).mode & 0o777).toBe(0o666 & ~umask);
  });
});
