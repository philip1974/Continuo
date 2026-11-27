import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 包装真实 rename,记录所有调用,验证原文件**从不**被 rename 成 .backup。
const renameCalls: Array<{ from: string; to: string }> = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: vi.fn(async (from: string, to: string) => {
      renameCalls.push({ from, to });
      return real.rename(from, to);
    }),
  };
});

import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-aw-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  renameCalls.splice(0);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// P2 回归:旧实现覆盖前先 rename(path → path.backup),在"原文件已挪走 / tmp 未就位"
// 之间留崩溃即丢数据的窗口。新建文件只 rename(tmp → path) 原子替换;覆盖已有文件原地写、不 rename。
// 断言:绝不出现 src=原文件 或 dst=*.backup 的 rename。
describe('49 · atomicWriteFile 不再有 .backup 数据丢失窗口', () => {
  // 覆盖已有普通文件现为原地写(同一 inode,见 src/__tests__/save-in-place/):根本不 rename,更无 .backup 窗口。
  it('覆盖已有文件:内容更新,不做任何 rename(原地写),从不出现 .backup', async () => {
    const dir = await tempDir();
    const file = join(dir, 'doc.md');
    await writeFile(file, 'OLD');

    await atomicWriteFile(file, 'NEW');

    expect(await readFile(file, 'utf-8')).toBe('NEW');
    expect(renameCalls).toEqual([]);
  });

  it('新建文件:正常写入,单次 rename(tmp → path)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'fresh.txt');

    await atomicWriteFile(file, 'hello');

    expect(await readFile(file, 'utf-8')).toBe('hello');
    expect(renameCalls.length).toBe(1);
    expect(renameCalls[0]!.from).toBe(join(dir, '.fresh.txt.continuo.tmp'));
    expect(renameCalls[0]!.to).toBe(file);
  });
});
