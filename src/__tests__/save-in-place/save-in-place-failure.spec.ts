// BDD: 原地保存写失败时原文件完整(磁盘满时原内容保住 —— 数据安全回归,不得退化成 VSCode「先截断再写」的半截文件)。
// 行为见同目录 README。被测:electron/main/ipc/fs/atomic-write.ts writeInPlace。
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { setupTempDirs } from '../_helpers/tmp-dir';

// 注入:只对 target 路径打开的句柄生效(tmp 不受影响)。
const inject = vi.hoisted(() => ({
  target: '' as string,
  /** position ≥ 此值的写抛 ENOSPC(模拟追加尾部时磁盘满)。 */
  enospcFrom: Infinity,
  /** 尾部写成功但 fdatasync 报 ENOSPC(延迟分配的文件系统在同步时才报)。 */
  enospcOnDatasync: false,
  /** 覆盖阶段(position 0)第一次写抛 EIO;回滚写照常。 */
  eioAtZeroOnce: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: vi.fn(async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      if (String(args[0]) !== inject.target) return fh;
      const realWrite = fh.write.bind(fh) as (...a: unknown[]) => Promise<{ bytesWritten: number }>;
      const realDatasync = fh.datasync.bind(fh);
      (fh as unknown as { write: unknown }).write = async (...a: unknown[]) => {
        const position = a[3] as number;
        if (position >= inject.enospcFrom) {
          // 真实磁盘满常先写进一部分再报错:写一个字节后抛,验证会截回原长度。
          await realWrite(a[0], a[1], 1, position);
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        if (position === 0 && inject.eioAtZeroOnce) {
          inject.eioAtZeroOnce = false;
          await realWrite(a[0], a[1], Math.min(2, a[2] as number), 0); // 覆盖了一部分才失败
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        }
        return realWrite(...a);
      };
      fh.datasync = async () => {
        if (inject.enospcOnDatasync) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        return realDatasync();
      };
      return fh;
    }),
  };
});

const { atomicWriteFile } = await import('../../../electron/main/ipc/fs/atomic-write');

const tmp = setupTempDirs();
afterEach(() => {
  inject.target = '';
  inject.enospcFrom = Infinity;
  inject.enospcOnDatasync = false;
  inject.eioAtZeroOnce = false;
});

async function fileWith(content: string): Promise<string> {
  const f = join(await tmp.make('continuo-inplace-fail-'), 'doc.md');
  await writeFile(f, content);
  inject.target = f;
  return f;
}

describe('原地保存失败:原文件完整', () => {
  it('新内容更长、追加尾部时磁盘满 → FS_NO_SPACE,原文件逐字节不变(长度截回)', async () => {
    const f = await fileWith('ORIGINAL');
    inject.enospcFrom = 'ORIGINAL'.length;
    await expect(atomicWriteFile(f, 'NEW CONTENT THAT IS LONGER')).rejects.toMatchObject({
      code: ERROR_CODES.FS_NO_SPACE,
    });
    expect(await readFile(f, 'utf-8')).toBe('ORIGINAL');
    expect((await readdir(join(f, '..'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('尾部写入成功但同步时才报磁盘满 → 同样截回,原文件不变', async () => {
    const f = await fileWith('ORIGINAL');
    inject.enospcOnDatasync = true;
    await expect(atomicWriteFile(f, 'NEW CONTENT THAT IS LONGER')).rejects.toMatchObject({
      code: ERROR_CODES.FS_NO_SPACE,
    });
    expect(await readFile(f, 'utf-8')).toBe('ORIGINAL');
  });

  it('覆盖原有长度部分时失败 → 用写前备份写回,原文件不变', async () => {
    const f = await fileWith('ORIGINAL CONTENT');
    inject.eioAtZeroOnce = true;
    await expect(atomicWriteFile(f, 'short')).rejects.toMatchObject({ code: ERROR_CODES.FS_IO });
    expect(await readFile(f, 'utf-8')).toBe('ORIGINAL CONTENT');
  });

  it('变长时覆盖阶段失败 → 回滚后长度也截回原长度', async () => {
    const f = await fileWith('ORIG');
    inject.eioAtZeroOnce = true;
    await expect(atomicWriteFile(f, 'MUCH LONGER NEW CONTENT')).rejects.toMatchObject({ code: ERROR_CODES.FS_IO });
    expect(await readFile(f, 'utf-8')).toBe('ORIG');
    expect((await stat(f)).size).toBe(4);
  });

  it('失败后再次保存(空间恢复)正常写入', async () => {
    const f = await fileWith('ORIGINAL');
    inject.enospcFrom = 'ORIGINAL'.length;
    await expect(atomicWriteFile(f, 'NEW CONTENT THAT IS LONGER')).rejects.toBeTruthy();
    inject.enospcFrom = Infinity;
    await atomicWriteFile(f, 'NEW CONTENT THAT IS LONGER');
    expect(await readFile(f, 'utf-8')).toBe('NEW CONTENT THAT IS LONGER');
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(process.platform === 'win32' || isRoot)('可写不可读的文件(0200,读不了回滚备份)→ 退回 tmp + rename,照常保存', async () => {
    const f = await fileWith('OLD');
    await chmod(f, 0o200);
    try {
      await atomicWriteFile(f, 'NEW');
      await chmod(f, 0o600);
      expect(await readFile(f, 'utf-8')).toBe('NEW');
    } finally {
      await chmod(f, 0o600).catch(() => {});
    }
  });
});
