// BDD: atomicWriteFile 保存回声身份在写句柄关闭后取
// Windows NTFS/FAT 在写句柄关闭时才刷新 LastWriteTime(GetFileTime 文档:"not fully updated until all
// handles used for writing have been closed")。旧实现 fsync 后经 fd.stat 取 written(关闭前),rename 后
// stat 目标严格比 mtimeMs → Windows 上几乎必然不一致,回声识别失效(每次保存整文件重读)。
// 新实现:fsync → close → stat(tmp) 作 written → rename → stat(target) 比对。

import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
// 模拟 NTFS「关闭写句柄时刷新 LastWriteTime」:关闭后把被写文件的 mtime 推后。
let bumpMtimeOnClose = false;
// 模拟 rename 之后、确认 stat 之前的外部改写。
let touchAfterRename = false;
// 模拟 stat(tmp) 失败。
let failTmpStat = false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const later = (): Date => new Date(Date.now() + 10_000);
  return {
    ...real,
    open: vi.fn(async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const p = String(args[0]);
      const realClose = fh.close.bind(fh);
      let closed = false;
      fh.close = async () => {
        if (closed) return realClose();
        closed = true;
        calls.push('close');
        await realClose();
        if (bumpMtimeOnClose) {
          const t = later();
          await real.utimes(p, t, t);
        }
      };
      return fh;
    }),
    stat: vi.fn(async (...args: Parameters<typeof real.stat>) => {
      const p = String(args[0]);
      calls.push(`stat:${p}`);
      if (failTmpStat && p.endsWith('.continuo.tmp')) {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return real.stat(...args);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      calls.push('rename');
      await real.rename(from, to);
      if (touchAfterRename) {
        const t = later();
        await real.utimes(to, t, t);
      }
    }),
  };
});

const { atomicWriteFile } = await import('../../../electron/main/ipc/fs/atomic-write');

const dirs: string[] = [];
afterEach(async () => {
  calls.splice(0);
  bumpMtimeOnClose = false;
  touchAfterRename = false;
  failTmpStat = false;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-aw-echo-'));
  dirs.push(d);
  return d;
}

describe('49 · atomicWriteFile 回声身份在写句柄关闭后取', () => {
  it('调用顺序:close → stat(tmp) → rename → stat(target)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'doc.md');
    const tmp = join(dir, '.doc.md.continuo.tmp');
    await writeFile(file, 'OLD');
    calls.splice(0);
    await atomicWriteFile(file, 'NEW');
    // existingFileMode 先 stat(target)(非 win32),其后为本次关注的序列
    const tail = calls.slice(calls.indexOf('close'));
    expect(tail).toEqual(['close', `stat:${tmp}`, 'rename', `stat:${file}`]);
  });

  it('写句柄关闭时 mtime 被平台刷新(NTFS 语义)→ 仍返回与目标一致的身份', async () => {
    bumpMtimeOnClose = true;
    const dir = await tempDir();
    const file = join(dir, 'doc.md');
    await writeFile(file, 'OLD');
    const written = await atomicWriteFile(file, 'NEW!');
    expect(await readFile(file, 'utf-8')).toBe('NEW!');
    const st = await fsp.stat(file);
    expect(written).toEqual({ mtimeMs: st.mtimeMs, size: 4, ino: st.ino });
  });

  it('rename 后目标与 written 不一致(外部改写)→ undefined,绝不误判为回声', async () => {
    touchAfterRename = true;
    const dir = await tempDir();
    const file = join(dir, 'doc.md');
    expect(await atomicWriteFile(file, 'NEW')).toBeUndefined();
    expect(await readFile(file, 'utf-8')).toBe('NEW');
  });

  it('stat(tmp) 失败 → 写盘照常成功,返回 undefined', async () => {
    failTmpStat = true;
    const dir = await tempDir();
    const file = join(dir, 'doc.md');
    expect(await atomicWriteFile(file, 'NEW')).toBeUndefined();
    expect(await readFile(file, 'utf-8')).toBe('NEW');
  });
});
