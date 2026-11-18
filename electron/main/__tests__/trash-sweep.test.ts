import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  promises as fsp,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTrashSweepThrottle,
  sweepStaleTrashInDir,
  trashPathFor,
} from '../services/plugin-fs.service';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'continuo-trash-'));
  tempRoots.push(dir);
  return dir;
}

const HOUR_MS = 60 * 60 * 1000;

/** 宿主形态的 trash 路径(生产同一个生成函数),名字里的时间戳在 ageMs 之前。 */
function hostTrash(root: string, ageMs: number, name = 'data-store.json'): string {
  return trashPathFor(join(root, name), `${Date.now() - ageMs}-ab12`);
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('sweepStaleTrashInDir', () => {
  it('T20bis.a removes host-shaped trash older than 24h', async () => {
    const root = makeTempDir();
    const trash = hostTrash(root, 25 * HOUR_MS);
    mkdirSync(trash);
    const past = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(trash, past, past);

    await expect(sweepStaleTrashInDir(root)).resolves.toEqual({
      swept: 1,
      failed: 0,
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('T20bis.b keeps host-shaped trash newer than 24h', async () => {
    const root = makeTempDir();
    const trash = hostTrash(root, 12 * HOUR_MS);
    mkdirSync(trash);
    const fresh = Date.now() / 1000 - 12 * 60 * 60;
    utimesSync(trash, fresh, fresh);

    await expect(sweepStaleTrashInDir(root)).resolves.toEqual({
      swept: 0,
      failed: 0,
    });
    expect(existsSync(trash)).toBe(true);
  });

  // 安全:只认 trashPathFor 的精确形态。用户 / 其它工具自己命名的 `.trash-*` 再旧也不动。
  it('T20bis.b2 leaves old `.trash-*` entries that are not host-shaped', async () => {
    const root = makeTempDir();
    const ts = String(Date.now() - 25 * HOUR_MS);
    const names = [
      '.trash-old',
      `.trash-x-${ts.slice(0, 12)}-ab12`, // 时间戳 12 位
      `.trash-x-${ts}0-ab12`, // 时间戳 14 位
      `.trash-x-${ts}-ab1`, // 随机段 3 位
      `.trash-x-${ts}-ab123`, // 随机段 5 位
      `.trash-y-${ts}-AB12`, // 大写
      `.trash-${ts}-ab12`, // 没有原 basename
      `x.trash-x-${ts}-ab12`, // 不以前缀开头
      `.trash-x-${ts}-ab12\n`, // 尾部多一个换行
    ];
    const past = Date.now() / 1000 - 25 * 60 * 60;
    for (const name of names) {
      writeFileSync(join(root, name), 'keep');
      utimesSync(join(root, name), past, past);
    }

    await expect(sweepStaleTrashInDir(root)).resolves.toEqual({
      swept: 0,
      failed: 0,
    });
    expect(readdirSync(root).sort()).toEqual([...new Set(names)].sort());
  });

  // 名字里的时间戳(移入 trash 的时刻)与 mtime 都要过期:目录改名不更新自身 mtime,只看 mtime 会把
  // 刚移入 trash 的旧目录当场删掉。
  it('T20bis.b3 needs both the embedded timestamp and the mtime to be stale', async () => {
    const root = makeTempDir();
    const justTrashedOldDir = hostTrash(root, 1000, 'old-dir');
    mkdirSync(justTrashedOldDir);
    const past = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(justTrashedOldDir, past, past);
    const staleNameFreshMtime = hostTrash(root, 25 * HOUR_MS, 'touched');
    writeFileSync(staleNameFreshMtime, 'recent');

    await expect(sweepStaleTrashInDir(root)).resolves.toEqual({
      swept: 0,
      failed: 0,
    });
    expect(existsSync(justTrashedOldDir)).toBe(true);
    expect(existsSync(staleNameFreshMtime)).toBe(true);
  });

  it('T20bis.c leaves non-trash files untouched', async () => {
    const root = makeTempDir();
    const file = join(root, 'not-a-trash');
    writeFileSync(file, 'keep');
    const past = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(file, past, past);

    await expect(sweepStaleTrashInDir(root)).resolves.toEqual({
      swept: 0,
      failed: 0,
    });
    expect(existsSync(file)).toBe(true);
  });

  it('T20bis.d nonexistent directory returns zero counts', async () => {
    await expect(
      sweepStaleTrashInDir('/definitely/nope/plugin-trash-dir'),
    ).resolves.toEqual({ swept: 0, failed: 0 });
  });

  // 回归:旧实现 trash 名是 `${finalPath}.trash-...`(后缀),不以 TRASH_PREFIX
  // 开头,sweep 永远漏掉真实产物。用真实 producer(trashPathFor)的名字断言 sweep
  // 能命中 —— 旧测试只用字面量 `.trash-old` 掩盖了这个 bug。
  it('T20bis.e sweeps a leaked trash produced by trashPathFor', async () => {
    const root = makeTempDir();
    const finalPath = join(root, 'data-store.json');
    const trash = trashPathFor(finalPath, '1700000000000-ab12');
    // 不变量 1:basename 以 .trash- 开头、以「13 位时间戳-4 位 base36」结尾,sweep 才认
    expect(trash.startsWith(join(root, '.trash-'))).toBe(true);
    writeFileSync(trash, 'leaked');
    const past = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(trash, past, past);

    await expect(sweepStaleTrashInDir(root)).resolves.toEqual({
      swept: 1,
      failed: 0,
    });
    expect(existsSync(trash)).toBe(false);
  });
});

// perf:ATOMIC_REPLACE 此前每次替换前无条件 readdir 整个父目录扫 .trash-*。sweep 只回收 >24h 的泄漏
// trash(纯清理,非替换正确性前置),改为按 canonical parent 节流(60s 一次,跟踪表有容量上限)。
describe('createTrashSweepThrottle', () => {
  it('同一目录 60s 内只扫一次;过期后再扫;不同目录各自独立;时钟回拨不卡死', async () => {
    const a = makeTempDir();
    const b = makeTempDir();
    let now = 1_000_000;
    const readdir = vi.spyOn(fsp, 'readdir');
    try {
      const sweep = createTrashSweepThrottle(() => now);
      await sweep(a);
      await sweep(a);
      now += 59_999;
      await sweep(a);
      expect(readdir).toHaveBeenCalledTimes(1);
      await sweep(b);
      expect(readdir).toHaveBeenCalledTimes(2);
      now += 1;
      await sweep(a);
      expect(readdir).toHaveBeenCalledTimes(3);
      now -= 3_600_000;
      await sweep(a);
      expect(readdir).toHaveBeenCalledTimes(4);
    } finally {
      readdir.mockRestore();
    }
  });

  it('节流放行时照常回收过期 trash', async () => {
    const root = makeTempDir();
    const trash = hostTrash(root, 25 * HOUR_MS);
    mkdirSync(trash);
    const past = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(trash, past, past);
    await createTrashSweepThrottle()(root);
    expect(existsSync(trash)).toBe(false);
  });

  it('跟踪表有容量上限:被淘汰的旧目录可再次扫描', async () => {
    const now = 0;
    const readdir = vi.spyOn(fsp, 'readdir').mockResolvedValue([] as never);
    try {
      const sweep = createTrashSweepThrottle(() => now, 2);
      await sweep('/x/1');
      await sweep('/x/2');
      await sweep('/x/3'); // 淘汰 /x/1
      expect(readdir).toHaveBeenCalledTimes(3);
      await sweep('/x/3');
      await sweep('/x/2');
      expect(readdir).toHaveBeenCalledTimes(3);
      await sweep('/x/1');
      expect(readdir).toHaveBeenCalledTimes(4);
    } finally {
      readdir.mockRestore();
    }
  });
});
