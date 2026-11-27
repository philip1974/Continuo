// BDD: 写时复制卷(APFS 克隆 / 快照共享块、btrfs / ZFS reflink)磁盘将满时原地保存 —— 覆盖已有块也要新空间,ENOSPC 拖到
// fsync / ftruncate 才报,回滚本身也会 ENOSPC。保证:任何失败路径下,要么原文件逐字节不变(报 FS_NO_SPACE 等原错误,不写副本),
// 要么报 FS_SAVE_ORIGINAL_DAMAGED 并给出完整原内容的恢复副本;回滚后读回与原内容一致就是前者(回滚的 fsync 失败也一样),
// 只有确实不一致才是后者。行为见同目录 README「写时复制卷 / 磁盘将满」。被测:electron/main/ipc/fs/atomic-write.ts。
// 真实 APFS 克隆复现见 tests/e2e/editor-save-in-place.spec.ts「APFS 克隆文件」。
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { setupTempDirs } from '../_helpers/tmp-dir';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null, fromId: () => null },
  dialog: {},
  shell: {},
}));

const ENOSPC = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

const inject = vi.hoisted(() => ({
  target: '',
  /** statfs 的替身:undefined = 真实 statfs(测试默认给足空间,见 beforeEach)。 */
  statfs: undefined as undefined | ((p: string) => Promise<unknown>),
  /** target 句柄上第 n 次(从 1 起)sync() 是否报 ENOSPC。 */
  syncFails: ((_n: number) => false) as (n: number) => boolean,
  syncCalls: 0,
  /** 一旦有 sync 失败过,之后 target 上的 truncate 也报 ENOSPC(写时复制卷上截断要改写共享块)。 */
  truncateFailsAfterSyncFailure: false,
  /** 一旦有 sync 失败过,之后 target 上的 write 也报 ENOSPC(回滚写不回去:文件里仍是新内容)。 */
  writeFailsAfterSyncFailure: false,
  /** 一旦有 sync 失败过,之后 target 上的 read 报 EIO(回滚后读不回来核对)。 */
  readFailsAfterSyncFailure: false,
  /** 恢复副本(`wx` 新建)一律打不开。 */
  failRecoveryOpen: false,
  syncFailed: false,
  /** target 句柄上的操作序列。 */
  ops: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    statfs: vi.fn((...args: Parameters<typeof real.statfs>) =>
      inject.statfs ? inject.statfs(String(args[0])) : real.statfs(...args),
    ),
    open: vi.fn(async (...args: Parameters<typeof real.open>) => {
      if (inject.failRecoveryOpen && args[1] === 'wx' && !String(args[0]).endsWith('.continuo.tmp')) throw ENOSPC();
      const fh = await real.open(...args);
      if (String(args[0]) !== inject.target) return fh;
      const realWrite = fh.write.bind(fh) as (...a: unknown[]) => Promise<{ bytesWritten: number }>;
      const realRead = fh.read.bind(fh) as (...a: unknown[]) => Promise<unknown>;
      (fh as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        if (inject.readFailsAfterSyncFailure && inject.syncFailed) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return realRead(...a);
      };
      const realSync = fh.sync.bind(fh);
      const realTruncate = fh.truncate.bind(fh);
      (fh as unknown as { write: unknown }).write = async (...a: unknown[]) => {
        inject.ops.push(`write@${String(a[3])}`);
        if (inject.writeFailsAfterSyncFailure && inject.syncFailed) throw ENOSPC();
        return realWrite(...a);
      };
      fh.sync = async () => {
        inject.syncCalls += 1;
        if (inject.syncFails(inject.syncCalls)) {
          inject.syncFailed = true;
          inject.ops.push('sync:ENOSPC');
          throw ENOSPC();
        }
        inject.ops.push('sync');
        return realSync();
      };
      fh.truncate = async (len?: number) => {
        inject.ops.push(`truncate(${String(len)})`);
        if (inject.truncateFailsAfterSyncFailure && inject.syncFailed) throw ENOSPC();
        return realTruncate(len);
      };
      return fh;
    }),
  };
});

const { atomicWriteFile, inPlaceSpaceNeeded, setSaveRecoveryDir } = await import(
  '../../../electron/main/ipc/fs/atomic-write'
);

const tmp = setupTempDirs();
let recoveryDir = '';
beforeEach(async () => {
  recoveryDir = join(await tmp.make('continuo-recovery-'), 'save-recovery');
  setSaveRecoveryDir(recoveryDir);
  // 默认:空间充足(与真实卷无关)。
  inject.statfs = async () => ({ type: 0, bsize: 4096, blocks: 1e9, bfree: 1e9, bavail: 1e9, files: 0, ffree: 0 });
});
afterEach(() => {
  inject.target = '';
  inject.statfs = undefined;
  inject.syncFails = () => false;
  inject.syncCalls = 0;
  inject.truncateFailsAfterSyncFailure = false;
  inject.writeFailsAfterSyncFailure = false;
  inject.readFailsAfterSyncFailure = false;
  inject.failRecoveryOpen = false;
  inject.syncFailed = false;
  inject.ops = [];
});

// 约 6 KB 的多行文本(模拟源码文件)。
const ORIGINAL = Array.from({ length: 200 }, (_, i) => `line ${i} some source code here;\n`).join('');
const lines = ORIGINAL.split('\n');
const DELETE_LINE_6 = [...lines.slice(0, 5), ...lines.slice(6)].join('\n');
const GROW_20K = `X${ORIGINAL.slice(1)}${'c'.repeat(20 * 1024)}`;

async function fileWith(content: string): Promise<string> {
  const f = join(await tmp.make('continuo-cow-'), 'f.txt');
  await writeFile(f, content);
  inject.target = f;
  return f;
}

async function failureOf(p: Promise<unknown>): Promise<{ code?: string; message: string; details?: { recoveryPath?: string } }> {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; message: string; details?: { recoveryPath?: string } };
  }
  throw new Error('expected the save to fail');
}

/** 恢复目录里的副本数(目录不存在 = 0)。 */
async function recoveryCopies(): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(recoveryDir).catch(() => [])).length;
}

/** 保证本身:原文件逐字节不变,或者报「原文件可能已损坏」且恢复副本逐字节等于原内容。 */
async function expectOriginalIntactOrRecovered(
  f: string,
  err: { code?: string; details?: { recoveryPath?: string } },
): Promise<void> {
  if (err.code === ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED) {
    expect(err.details?.recoveryPath).toBeTruthy();
    expect((await readFile(err.details!.recoveryPath!)).equals(Buffer.from(ORIGINAL))).toBe(true);
  } else {
    expect((await readFile(f)).equals(Buffer.from(ORIGINAL))).toBe(true);
  }
}

const MB = 1024 * 1024;
const KB = 1024;
/**
 * 实测(macOS 15,hdiutil 建的 APFS 卷;卷大小 = statfs blocks × bsize):克隆文件(`cp -c`)整段改写一次并 fsync 成功所需的最小
 * 可用空间(statfs bavail × bsize,KB 精度的二分)。小于它时 fsync 报 ENOSPC。规律:≈ 卷的保留量(随卷变大,20 MB 卷约 2 MB、
 * 200 MB 卷约 5.7 MB、1 GB 卷约 23 MB、4 GB 卷约 33 MB)+ 文件大小 + min(文件大小, 约 2 MB)。
 */
const MEASURED_COW_REWRITE: readonly { volume: number; size: number; needed: number }[] = [
  { volume: 20_440 * KB, size: 97_890, needed: 2_156 * KB },
  { volume: 20_440 * KB, size: 1_008_890, needed: 4_125 * KB },
  { volume: 20_440 * KB, size: 2_028_890, needed: 6_281 * KB },
  { volume: 20_440 * KB, size: 4_088_890, needed: 8_226 * KB },
  { volume: 204_760 * KB, size: 97_890, needed: 5_859 * KB },
  { volume: 204_760 * KB, size: 1_008_890, needed: 7_734 * KB },
  { volume: 204_760 * KB, size: 2_028_890, needed: 9_843 * KB },
  { volume: 204_760 * KB, size: 6_188_890, needed: 13_827 * KB },
  { volume: 204_760 * KB, size: 20_888_890, needed: 28_281 * KB },
  { volume: 1_048_536 * KB, size: 97_890, needed: 23_040 * KB },
  { volume: 1_048_536 * KB, size: 2_028_890, needed: 26_624 * KB },
  { volume: 3_989_464 * KB, size: 97_890, needed: 34_375 * KB },
];

describe('可用空间预检:不够就一个字节都不写', () => {
  it('预检要求的空间覆盖实测:克隆文件在任何一个实测卷 / 大小上,预检通过就不会因空间不够在 fsync 时失败', () => {
    for (const m of MEASURED_COW_REWRITE) {
      expect(inPlaceSpaceNeeded(m.size, m.volume), `${m.volume} B 卷、${m.size} B 文件`).toBeGreaterThanOrEqual(m.needed);
    }
  });

  it('回归:20 MB 卷上 2 MB 克隆文件、卷剩约 5.4 MB(旧预检 2 × 内容 + 1 MiB 放行,写入必然失败)→ 预检拒绝', () => {
    expect(inPlaceSpaceNeeded(2_028_890, 20_440 * KB)).toBeGreaterThan(5_416 * KB);
  });

  it('预检的额外余量有上限:大卷上不因为「卷很大」就拒绝普通保存(1 TB 卷、1 MB 文件:约需 3 MB + 256 MB)', () => {
    expect(inPlaceSpaceNeeded(MB, 1024 * 1024 * MB)).toBe(3 * MB + 256 * MB);
  });

  it('可用空间 < 预检要求 → FS_NO_SPACE,原文件逐字节不变、没有对它写任何字节', async () => {
    const f = await fileWith(ORIGINAL);
    const needed = inPlaceSpaceNeeded(Buffer.byteLength(DELETE_LINE_6), 1e9);
    inject.statfs = async () => ({ bsize: 1, blocks: 1e9, bavail: needed - 1 });
    const err = await failureOf(atomicWriteFile(f, DELETE_LINE_6));
    expect(err.code).toBe(ERROR_CODES.FS_NO_SPACE);
    expect((await readFile(f)).equals(Buffer.from(ORIGINAL))).toBe(true);
    expect(inject.ops.filter((o) => o.startsWith('write') || o.startsWith('truncate'))).toEqual([]);
  });

  it('可用空间刚好够 → 正常原地保存(同一 inode)', async () => {
    const f = await fileWith(ORIGINAL);
    const ino = (await stat(f)).ino;
    inject.statfs = async () => ({ bsize: 1, blocks: 1e9, bavail: inPlaceSpaceNeeded(Buffer.byteLength(GROW_20K), 1e9) });
    await atomicWriteFile(f, GROW_20K);
    expect(await readFile(f, 'utf-8')).toBe(GROW_20K);
    expect((await stat(f)).ino).toBe(ino);
  });

  it('statfs 失败 / 报 0 块(部分 FUSE / 网络卷)→ 视为未知,照常保存', async () => {
    const f = await fileWith(ORIGINAL);
    inject.statfs = async () => {
      throw Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' });
    };
    await atomicWriteFile(f, DELETE_LINE_6);
    expect(await readFile(f, 'utf-8')).toBe(DELETE_LINE_6);
    inject.statfs = async () => ({ bsize: 4096, blocks: 0, bavail: 0 });
    await atomicWriteFile(f, ORIGINAL);
    expect(await readFile(f, 'utf-8')).toBe(ORIGINAL);
  });
});

describe('预检通过但覆盖时才 ENOSPC(写时复制卷 / 空间被别的进程占掉)', () => {
  it('删一行(变短):覆盖后 fsync 报 ENOSPC → 原文件逐字节不变,末尾不会变成 NUL;截短只在覆盖落盘之后', async () => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = (n) => n === 1;
    const err = await failureOf(atomicWriteFile(f, DELETE_LINE_6));
    expect(err.code).toBe(ERROR_CODES.FS_NO_SPACE);
    const after = await readFile(f);
    expect(after.includes(0)).toBe(false);
    expect(after.equals(Buffer.from(ORIGINAL))).toBe(true);
    expect(inject.ops).not.toContain(`truncate(${Buffer.byteLength(DELETE_LINE_6)})`);
  });

  it('回归:删一行,回滚的 fsync / ftruncate 也 ENOSPC 但读回与原内容一致 → FS_NO_SPACE(原文件未改动),不写恢复副本', async () => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = () => true;
    inject.truncateFailsAfterSyncFailure = true;
    const err = await failureOf(atomicWriteFile(f, DELETE_LINE_6));
    expect(err.code).toBe(ERROR_CODES.FS_NO_SPACE);
    expect(err.message).toMatch(/original unchanged/);
    expect((await readFile(f)).equals(Buffer.from(ORIGINAL))).toBe(true);
    expect(await recoveryCopies()).toBe(0);
  });

  it.each([
    ['删一行', DELETE_LINE_6],
    ['末尾加一行', `${ORIGINAL}one more line;\n`],
    ['同长替换', `X${ORIGINAL.slice(1)}`],
  ])('%s:覆盖后 fsync 失败、回滚的 fsync 也失败,写回成功 → FS_NO_SPACE,不写恢复副本', async (_name, next) => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = () => true;
    const err = await failureOf(atomicWriteFile(f, next));
    expect(err.code).toBe(ERROR_CODES.FS_NO_SPACE);
    expect((await readFile(f)).equals(Buffer.from(ORIGINAL))).toBe(true);
    expect(await recoveryCopies()).toBe(0);
  });

  it('删一行:回滚时写不回原内容(读回仍是新内容)→ FS_SAVE_ORIGINAL_DAMAGED,恢复副本是完整原内容(0600)', async () => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = () => true;
    inject.writeFailsAfterSyncFailure = true;
    const err = await failureOf(atomicWriteFile(f, DELETE_LINE_6));
    expect(err.code).toBe(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED);
    const recovery = err.details!.recoveryPath!;
    expect(recovery.startsWith(recoveryDir)).toBe(true);
    expect(recovery.endsWith('-f.txt')).toBe(true);
    expect(err.message).toContain(recovery);
    expect((await readFile(recovery)).equals(Buffer.from(ORIGINAL))).toBe(true);
    if (process.platform !== 'win32') expect((await stat(recovery)).mode & 0o777).toBe(0o600);
  });

  it('开头改一字 + 末尾加 20 KB(变长):回滚截不回原长度 → 不报普通的「磁盘空间不足」,给出完整原内容副本', async () => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = () => true;
    inject.truncateFailsAfterSyncFailure = true;
    const err = await failureOf(atomicWriteFile(f, GROW_20K));
    expect(err.code).toBe(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED);
    await expectOriginalIntactOrRecovered(f, err);
  });

  it('变长:覆盖后 fsync 报 ENOSPC、回滚成功 → FS_NO_SPACE,追加的尾部被截掉,原文件逐字节不变', async () => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = (n) => n === 1;
    const err = await failureOf(atomicWriteFile(f, GROW_20K));
    expect(err.code).toBe(ERROR_CODES.FS_NO_SPACE);
    expect((await readFile(f)).equals(Buffer.from(ORIGINAL))).toBe(true);
  });

  it('变短:截短后的 fsync 报 ENOSPC → 写回被截掉的尾部,原文件逐字节不变', async () => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = (n) => n === 2; // 第 1 次(覆盖后)成功,第 2 次(截短后)失败,回滚的第 3 次成功
    const err = await failureOf(atomicWriteFile(f, DELETE_LINE_6));
    expect(err.code).toBe(ERROR_CODES.FS_NO_SPACE);
    expect((await readFile(f)).equals(Buffer.from(ORIGINAL))).toBe(true);
  });

  it('回滚后读不回来核对 → 不能断定原文件完好 → FS_SAVE_ORIGINAL_DAMAGED + 副本', async () => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = () => true;
    inject.readFailsAfterSyncFailure = true;
    const err = await failureOf(atomicWriteFile(f, DELETE_LINE_6));
    expect(err.code).toBe(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED);
    expect((await readFile(err.details!.recoveryPath!)).equals(Buffer.from(ORIGINAL))).toBe(true);
  });

  it('同样的原内容再次失败(自动保存反复重试)→ 复用上次的恢复副本,不再多写一份', async () => {
    const f = await fileWith(ORIGINAL);
    inject.syncFails = () => true;
    inject.readFailsAfterSyncFailure = true;
    const first = await failureOf(atomicWriteFile(f, DELETE_LINE_6));
    inject.syncFailed = false; // 第二次保存同样先写入成功、fsync 时才失败
    const second = await failureOf(atomicWriteFile(f, `${DELETE_LINE_6}more`));
    expect(second.code).toBe(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED);
    expect(second.details!.recoveryPath).toBe(first.details!.recoveryPath);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(recoveryDir)).toHaveLength(1);
  });

  it('配置的恢复目录写不了 → 退到系统临时目录;两处都写不了 → 仍报 FS_SAVE_ORIGINAL_DAMAGED(说明副本也没写成)', async () => {
    const blocker = join(await tmp.make('continuo-recovery-blocker-'), 'file');
    await writeFile(blocker, '');
    setSaveRecoveryDir(join(blocker, 'sub')); // 父路径是文件 → ENOTDIR
    const f = await fileWith(ORIGINAL);
    inject.syncFails = () => true;
    inject.writeFailsAfterSyncFailure = true;
    const err = await failureOf(atomicWriteFile(f, DELETE_LINE_6));
    expect(err.code).toBe(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED);
    const recovery = err.details!.recoveryPath!;
    try {
      expect(recovery.startsWith(join(tmpdir(), 'continuo-save-recovery'))).toBe(true);
      expect((await readFile(recovery)).equals(Buffer.from(ORIGINAL))).toBe(true);
    } finally {
      await rm(recovery, { force: true });
    }

    const g = await fileWith(ORIGINAL);
    inject.syncFailed = false;
    inject.syncFails = () => true;
    inject.writeFailsAfterSyncFailure = true;
    inject.failRecoveryOpen = true;
    const err2 = await failureOf(atomicWriteFile(g, DELETE_LINE_6));
    expect(err2.code).toBe(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED);
    expect(err2.details).toBeUndefined();
    expect(err2.message).toMatch(/recovery copy also failed/);
  });
});

describe('fs:write-file:原文件可能已损坏的提示带恢复副本路径(当前语言)', () => {
  it('英文界面 → 「…saved to <路径>」,code 仍是 FS_SAVE_ORIGINAL_DAMAGED', async () => {
    const { writeFileHandler } = await import('../../../electron/main/ipc/fs.ipc');
    const f = await fileWith(ORIGINAL);
    inject.syncFails = () => true;
    inject.writeFailsAfterSyncFailure = true;
    const err = await failureOf(writeFileHandler({ path: f, content: DELETE_LINE_6 }));
    expect(err.code).toBe(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED);
    const recovery = err.details!.recoveryPath!;
    expect(err.message).toBe(
      `Save failed and the original file could not be restored, so it may be damaged. A complete copy of the original content was saved to ${recovery}`,
    );
  });
});

describe('提示文案(renderer)', () => {
  it('FS_SAVE_ORIGINAL_DAMAGED 有 message(main 已按语言写好、含副本路径)→ 原样显示;没有 message → catalog 通用文案', async () => {
    const { localizeErrorByCode } = await import('../../../src/lib/localize-error');
    const { setLocale } = await import('../../../src/i18n');
    setLocale('en');
    const msg = '保存失败，且未能还原原文件，原文件可能已损坏。完整的原内容已另存到 /u/save-recovery/x-f.txt';
    expect(localizeErrorByCode(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED, msg)).toBe(msg);
    expect(localizeErrorByCode(ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED, '')).toBe(
      'Save failed and the original file could not be restored, so it may be damaged',
    );
  });
});
