import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
