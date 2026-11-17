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

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('sweepStaleTrashInDir', () => {
  it('T20bis.a removes .trash-* older than 24h', async () => {
    const root = makeTempDir();
    const trash = join(root, '.trash-old');
    mkdirSync(trash);
    const past = Date.now() / 1000 - 25 * 60 * 60;
    utimesSync(trash, past, past);

    await expect(sweepStaleTrashInDir(root)).resolves.toEqual({
      swept: 1,
      failed: 0,
    });
    expect(readdirSync(root)).not.toContain('.trash-old');
  });

  it('T20bis.b keeps .trash-* newer than 24h', async () => {
    const root = makeTempDir();
    const trash = join(root, '.trash-fresh');
    mkdirSync(trash);
    const fresh = Date.now() / 1000 - 12 * 60 * 60;
    utimesSync(trash, fresh, fresh);

    await expect(sweepStaleTrashInDir(root)).resolves.toEqual({
      swept: 0,
      failed: 0,
    });
    expect(existsSync(trash)).toBe(true);
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
    // 不变量 1:basename 必须以 .trash- 开头,sweep 才能匹配
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
    const trash = join(root, '.trash-old');
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
