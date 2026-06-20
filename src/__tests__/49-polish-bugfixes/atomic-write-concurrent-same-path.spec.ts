// topic 49 第十四轮 · P1-AL(第十八轮自审修订):同一路径并发原子写不产生半截文件/丢写报错。
//
// 根因:旧 atomicWriteFile 用固定 `${filePath}.tmp`。同路径并发写(autosave 连发 /
// 手动 Cmd+S 与 autosave 重叠 / 多窗或插件同写一文件)共享同一 tmp:互相 `open('w')`
// 截断 → 落盘半截文件;或 A rename(tmp→path) 后 B rename 撞 ENOENT → B 的写整段丢失
// 且向 renderer 抛错。
// 修复(修订后):**per-path 串行化 + 固定 tmp 名**。同路径写排队,各自完整 rename =
// 干净 last-writer-wins;固定 tmp 名让 crash 残留的单个 `.tmp` 下次同路径写复用覆盖、
// 自愈(第十四轮一度用唯一 tmp 名,但自审发现唯一名 crash 后累积不可回收的孤儿 .tmp,
// 故改回固定名 + 串行化)。

import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-aw-conc-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('49 P1-AL · atomicWriteFile 同路径并发写不损坏', () => {
  it('两次并发写同一路径:都成功,最终是某次完整内容(非半截)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'doc.md');
    const a = 'A'.repeat(5000);
    const b = 'B'.repeat(5000);

    // 并发触发(不 await 第一个就发第二个)—— 旧固定 tmp 会互相截断/撞 ENOENT
    await Promise.all([atomicWriteFile(file, a), atomicWriteFile(file, b)]);

    const final = await readFile(file, 'utf-8');
    // 最终内容必须是 a 或 b 之一的完整副本,不能是混合/半截
    expect(final === a || final === b).toBe(true);
    expect(final.length).toBe(5000);
  });

  it('多次并发写同一路径都 resolve(无 ENOENT 丢写报错)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'note.txt');
    const writes = Array.from({ length: 8 }, (_, i) =>
      atomicWriteFile(file, `payload-${i}-${'x'.repeat(1000)}`),
    );
    // 全部 resolve,无一因共享 tmp 撞 ENOENT 而 reject
    await expect(Promise.all(writes)).resolves.toBeDefined();
    const final = await readFile(file, 'utf-8');
    expect(/^payload-\d-x{1000}$/.test(final)).toBe(true);
  });

  it('并发写不残留 .tmp 文件(各自 rename 消费掉)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.json');
    await Promise.all([
      atomicWriteFile(file, '{"v":1}'),
      atomicWriteFile(file, '{"v":2}'),
    ]);
    const left = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(left).toEqual([]);
  });

  it('固定 tmp 名:crash 残留的孤儿 .tmp 被下次写复用、不累积(自审回归锁定)', async () => {
    const dir = await tempDir();
    const file = join(dir, 'doc.md');
    // 模拟上次 crash 在 fsync→rename 窗口残留的孤儿 tmp
    await writeFile(`${file}.tmp`, 'STALE-ORPHAN');

    await atomicWriteFile(file, 'fresh');

    // 固定 tmp 名 → 被复用覆盖并 rename 消费,目录里不再有任何 .tmp(不累积孤儿)
    expect(await readFile(file, 'utf-8')).toBe('fresh');
    const left = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(left).toEqual([]);
  });
});
