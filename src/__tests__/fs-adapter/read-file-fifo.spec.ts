// 安全(FIFO 卡死主进程):readFile 此前只用 lstat 排除目录,FIFO / 指向 FIFO 的符号链接都放行,
// 随后 readFileCappedFd 的跟随链接分支 `fs.open(path,'r')` 不带 O_NONBLOCK —— FIFO 无写端时 open 永不
// 返回,永久占住一个 libuv 线程池线程;并发打开 4 次就占满线程池,主进程所有 fs.promises(保存 /
// listDir / 持久化)全部挂起。工作区(如 clone 的仓库)可放 FIFO,用户在 Explorer 点开即触发。
//
// 期望:open 用 O_RDONLY|O_NONBLOCK(FIFO 立即返回),open 后 fstat 非普通文件 → FS_NOT_FILE,迅速失败,
// 之后 fs 操作照常。
//
// 防测试自身挂死:每次读取都 Promise.race 短超时;finally 用 O_WRONLY|O_NONBLOCK 打开写端
// ——若有读端卡在 open 里,写端打开即解除它的阻塞(无读端则 ENXIO,忽略),线程池不会被测试泄漏。

import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from '../../../electron/main/ipc/fs/read-file';
import { readFileCappedFd } from '../../../electron/main/lib/read-fh-capped';
import { listPluginDirs } from '../../../electron/main/services/plugins.service';

const TIMEOUT = Symbol('timeout');

function withTimeout<T>(p: Promise<T>, ms = 1500): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), ms))]);
}

/** 打开非阻塞写端解除卡在 open 里的读端;无读端时 ENXIO,忽略。 */
function unblockReaders(fifo: string): void {
  for (let i = 0; i < 8; i++) {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      return;
    }
  }
}

const roots: string[] = [];
const fifos: string[] = [];
afterEach(async () => {
  for (const f of fifos.splice(0)) unblockReaders(f);
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function makeFifo(): Promise<{ dir: string; fifo: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'continuo-fifo-'));
  roots.push(dir);
  const fifo = join(dir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  fifos.push(fifo);
  return { dir, fifo };
}

async function settle(p: Promise<unknown>): Promise<unknown> {
  return withTimeout(p.then(() => 'resolved', (e: unknown) => e));
}

describe.skipIf(process.platform === 'win32')('readFile 拒绝 FIFO(不挂死主进程线程池)', () => {
  it('直接打开 FIFO → 迅速抛 FS_NOT_FILE', async () => {
    const { fifo } = await makeFifo();
    const r = await settle(readFile(fifo));
    expect(r).not.toBe(TIMEOUT);
    expect(r).toMatchObject({ code: 'FS_NOT_FILE' });
  });

  it('符号链接指向 FIFO(lstat 看是链接,绕过目录检查)→ 迅速抛 FS_NOT_FILE', async () => {
    const { dir, fifo } = await makeFifo();
    const link = join(dir, 'README.md');
    await symlink(fifo, link);
    const r = await settle(readFile(link));
    expect(r).not.toBe(TIMEOUT);
    expect(r).toMatchObject({ code: 'FS_NOT_FILE' });
  });

  it('并发打开 FIFO 多次后,其它 fs.promises 仍正常返回', async () => {
    const { dir, fifo } = await makeFifo();
    const results = await Promise.all(Array.from({ length: 6 }, () => settle(readFile(fifo))));
    for (const r of results) expect(r).not.toBe(TIMEOUT);
    const f = join(dir, 'ok.txt');
    await writeFile(f, 'hi', 'utf8');
    expect(await withTimeout(stat(f).then(() => 'ok'))).toBe('ok');
    expect(await withTimeout(readFile(f))).toBe('hi');
  });

  it('helper 层:跟随链接分支对 FIFO 抛 EFTYPE,普通文件读取不受 O_NONBLOCK 影响', async () => {
    const { dir, fifo } = await makeFifo();
    const r = await settle(readFileCappedFd(fifo, 1024));
    expect(r).not.toBe(TIMEOUT);
    expect(r).toMatchObject({ code: 'EFTYPE' });
    const f = join(dir, 'a.txt');
    await writeFile(f, 'x'.repeat(100_000), 'utf8');
    await expect(readFileCappedFd(f, 1024 * 1024)).resolves.toMatchObject({ size: 100_000, tooLarge: false });
  });

  it('同族:插件列举时 main 是指向 FIFO 的链接 → 迅速跳过该插件,不挂死', async () => {
    const { dir, fifo } = await makeFifo();
    const base = join(dir, 'plugins');
    await mkdir(join(base, 'evil'), { recursive: true });
    await writeFile(join(base, 'evil', 'manifest.json'), '{"id":"evil"}', 'utf8');
    await symlink(fifo, join(base, 'evil', 'main.js'));
    const r = await withTimeout(listPluginDirs(base));
    expect(r).not.toBe(TIMEOUT);
    expect(r).toEqual([]);
  });
});
