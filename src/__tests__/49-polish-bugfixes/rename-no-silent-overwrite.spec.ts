// topic 49 第七轮 · P1-T:renameEntry 拒绝静默覆盖已存在的目标。
//
// 根因:POSIX rename(2) 原子覆盖既有文件/空目录。旧 renameEntry 只校验源存在,
// 直接 rename(old, new) → Explorer 把文件 A 改成已存在文件 B 的名字时,B 被
// 覆盖并永久丢失(无回收站、无确认)。同模块 moveEntry 早有 dest-exists 拒绝,
// rename 这条路漏了。
//
// 修复:目标已存在且与源不是同一 inode → FS_EEXIST。大小写不敏感盘上
// File.txt→file.txt 等"改名到自身"(同 inode)仍放行。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renameEntry } from '../../../electron/main/ipc/fs/rename';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rename-overwrite-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function expectErrCode(fn: () => Promise<unknown>, code: string) {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string } | undefined)?.code).toBe(code);
}

describe('topic49 P1-T · renameEntry 不静默覆盖', () => {
  it('目标已存在(不同文件) → FS_EEXIST,旧文件内容完好', async () => {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    await writeFile(a, 'AAA');
    await writeFile(b, 'BBB-keep');

    await expectErrCode(() => renameEntry(a, 'b.txt'), 'FS_EEXIST');

    // B 未被覆盖,A 仍在
    expect(await readFile(b, 'utf-8')).toBe('BBB-keep');
    expect(await readFile(a, 'utf-8')).toBe('AAA');
  });

  it('目标已存在(目录) → FS_EEXIST', async () => {
    const a = path.join(dir, 'a.txt');
    await writeFile(a, 'AAA');
    await mkdir(path.join(dir, 'target'));
    await expectErrCode(() => renameEntry(a, 'target'), 'FS_EEXIST');
    expect(await readFile(a, 'utf-8')).toBe('AAA');
  });

  it('目标不存在 → 正常改名', async () => {
    const a = path.join(dir, 'a.txt');
    await writeFile(a, 'AAA');
    const newPath = await renameEntry(a, 'renamed.txt');
    expect(newPath).toBe(path.join(dir, 'renamed.txt'));
    expect(await readFile(newPath, 'utf-8')).toBe('AAA');
  });

  it('改名到自身(同 inode) → 放行(覆盖大小写盘上的 no-op 改名场景)', async () => {
    const a = path.join(dir, 'a.txt');
    await writeFile(a, 'AAA');
    // 改成与自身解析到同一 inode 的名字。最稳的同 inode 场景是改回同名:
    const newPath = await renameEntry(a, 'a.txt');
    expect(newPath).toBe(a);
    expect(await readFile(a, 'utf-8')).toBe('AAA');
    // 确认没把文件搞没
    expect((await stat(a)).isFile()).toBe(true);
  });
});
