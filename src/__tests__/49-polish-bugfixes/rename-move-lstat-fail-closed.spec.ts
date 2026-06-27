// 数据安全(codex 复查 P1):renameEntry / moveEntry 的「目标已存在」防覆盖守卫此前把
// **所有** lstat(dst) 错误都当「不存在」继续执行 rename → EACCES/EIO/ELOOP 等「无法确认
// 目标状态」时防覆盖被绕过,POSIX rename 静默覆盖已有目标。修复:只吞 ENOENT,其它 lstat
// 错误抛出中止(fail-closed)。plugin-fs:rename / plugin-fs:cp 同族同修。

import { vi } from 'vitest';

// lstat 必须可控:src 路径走真实 lstat,dst 路径抛 EACCES(模拟无法确认目标)。
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, lstat: vi.fn(real.lstat) };
});

import { lstat, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameEntry } from '../../../electron/main/ipc/fs/rename';
import { moveEntry } from '../../../electron/main/ipc/fs/move-copy';

const realLstat = (await vi.importActual<typeof import('node:fs/promises')>(
  'node:fs/promises',
)).lstat;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rename-failclosed-'));
  (lstat as unknown as ReturnType<typeof vi.fn>).mockImplementation(realLstat);
});
afterEach(async () => {
  vi.restoreAllMocks();
  (lstat as unknown as ReturnType<typeof vi.fn>).mockImplementation(realLstat);
  await rm(dir, { recursive: true, force: true });
});

function failDstLstat(dstAbs: string): void {
  (lstat as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (p: Parameters<typeof realLstat>[0]) => {
      if (String(p) === dstAbs) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return realLstat(p);
    },
  );
}

describe('rename/move 防覆盖守卫:lstat 非 ENOENT 错误 fail-closed', () => {
  it('renameEntry:dst lstat EACCES → 抛,不覆盖已有目标', async () => {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    await writeFile(a, 'AAA');
    await writeFile(b, 'BBB');
    failDstLstat(b);

    await expect(renameEntry(a, 'b.txt')).rejects.toMatchObject({
      code: 'FS_DENIED',
    });
    // b 未被覆盖,a 仍在
    expect(await readFile(b, 'utf-8')).toBe('BBB');
    expect(await readFile(a, 'utf-8')).toBe('AAA');
  });

  it('moveEntry:dst lstat EACCES → 抛,不覆盖已有目标', async () => {
    const a = path.join(dir, 'src.txt');
    const b = path.join(dir, 'dst.txt');
    await writeFile(a, 'AAA');
    await writeFile(b, 'BBB');
    failDstLstat(b);

    await expect(moveEntry(a, b)).rejects.toMatchObject({ code: 'FS_DENIED' });
    expect(await readFile(b, 'utf-8')).toBe('BBB');
    expect(await readFile(a, 'utf-8')).toBe('AAA');
  });
});
