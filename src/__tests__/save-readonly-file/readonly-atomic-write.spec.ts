// 只读(写保护)文件的保存:主进程原子写拒绝覆盖,除非调用方明示 overwriteReadonly(仅编辑器保存在用户确认后传)。
// 行为见同目录 README。被测:electron/main/ipc/fs/atomic-write.ts、electron/main/ipc/fs.ipc.ts writeFileInputSchema。
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  atomicReplaceFileNoFollow,
  atomicWriteFile,
} from '../../../electron/main/ipc/fs/atomic-write';
import { writeFileInputSchema } from '../../../electron/main/ipc/fs.ipc';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { setupTempDirs } from '../_helpers/tmp-dir';

const tmp = setupTempDirs();

async function readonlyFile(content = 'orig'): Promise<string> {
  const f = join(await tmp.make('continuo-ro-'), 'note.txt');
  await writeFile(f, content);
  await chmod(f, 0o444);
  return f;
}

// root 对任何文件都可写(access 恒通过),但 mode 无写位的检查仍生效;Windows 上 0o444 对应只读属性。
describe('只读文件保存', () => {
  it('编辑器保存(atomicWriteFile)遇只读文件 → 抛 FS_READONLY,磁盘内容与权限不变', async () => {
    const f = await readonlyFile();
    await expect(atomicWriteFile(f, 'mine')).rejects.toMatchObject({ code: ERROR_CODES.FS_READONLY });
    expect(await readFile(f, 'utf-8')).toBe('orig');
    expect((await stat(f)).mode & 0o222).toBe(0);
  });

  it('用户确认覆盖(overwriteReadonly)→ 去掉写保护(加属主写位)后写入,不恢复只读(同 VSCode unlock)', async () => {
    const f = await readonlyFile();
    await atomicWriteFile(f, 'mine', { overwriteReadonly: true });
    expect(await readFile(f, 'utf-8')).toBe('mine');
    expect((await stat(f)).mode & 0o200).toBe(0o200);
  });

  it('插件写 / 拖入覆盖 / CLI 配置写(atomicReplaceFileNoFollow)遇只读文件 → 直接 FS_READONLY,无覆盖选项', async () => {
    const f = await readonlyFile();
    await expect(atomicReplaceFileNoFollow(f, 'mine')).rejects.toMatchObject({
      code: ERROR_CODES.FS_READONLY,
    });
    expect(await readFile(f, 'utf-8')).toBe('orig');
  });

  it('可写文件 / 新建文件不受影响', async () => {
    const dir = await tmp.make('continuo-ro-');
    const f = join(dir, 'a.txt');
    await writeFile(f, 'x');
    await atomicWriteFile(f, 'y');
    expect(await readFile(f, 'utf-8')).toBe('y');
    await atomicWriteFile(join(dir, 'new.txt'), 'n');
    expect(await readFile(join(dir, 'new.txt'), 'utf-8')).toBe('n');
  });

  it('fs:write-file 入参接受可选 overwriteReadonly 布尔值,拒绝其它类型', () => {
    expect(writeFileInputSchema.safeParse({ path: '/a', content: 'x', overwriteReadonly: true }).success).toBe(true);
    expect(writeFileInputSchema.safeParse({ path: '/a', content: 'x' }).success).toBe(true);
    expect(writeFileInputSchema.safeParse({ path: '/a', content: 'x', overwriteReadonly: 'yes' }).success).toBe(false);
  });
});
