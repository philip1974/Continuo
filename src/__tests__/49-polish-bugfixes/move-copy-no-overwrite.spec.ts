// 数据安全(codex 复查 P2 + 同族兄弟):Node fs.cp 默认 force:true 会**击穿**
// errorOnExist:true(实测:errorOnExist 仅在 force:false 时生效)→ 静默覆盖已存在目标。
// copyEntry 注释承诺「destPath 已存在 → FS_EEXIST」却因此被击穿,实际静默覆盖(无 pre-check
// 完全依赖该选项);moveEntry 的 EXDEV cp fallback / plugin-fs:cp 同族。修:fs.cp 传 force:false
// 让 errorOnExist 真正生效,并把 ERR_FS_CP_EEXIST 映射到 FS_EEXIST。

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyEntry } from '../../../electron/main/ipc/fs/move-copy';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-mc-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('move-copy copyEntry 非覆盖契约(fs.cp force:false)', () => {
  it('目标已存在 → 抛 FS_EEXIST 且不覆盖原内容', async () => {
    const d = await tmp();
    const src = join(d, 'src.txt');
    const dst = join(d, 'dst.txt');
    await writeFile(src, 'SRC', 'utf-8');
    await writeFile(dst, 'DST-ORIGINAL', 'utf-8');

    await expect(copyEntry(src, dst)).rejects.toMatchObject({
      code: 'FS_EEXIST',
    });
    // 原文件未被静默覆盖
    expect(await readFile(dst, 'utf-8')).toBe('DST-ORIGINAL');
  });

  it('目标不存在 → 正常复制', async () => {
    const d = await tmp();
    const src = join(d, 's.txt');
    const dst = join(d, 'd.txt');
    await writeFile(src, 'SRC', 'utf-8');
    await copyEntry(src, dst);
    expect(await readFile(dst, 'utf-8')).toBe('SRC');
  });
});
