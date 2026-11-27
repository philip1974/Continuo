// BDD:删除前为撤销读回(main fs:read-for-undo,README 规则 3):文件 → 内容;文件夹 → 只标记;符号链接不跟随 → unsupported;
// 不存在 → FS_NOT_FOUND。超过 5MB 的 tooLarge 分支由 file-undo.spec 经假 fs 覆盖(不在测试里建大文件)。
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readForUndoHandler } from '../../../electron/main/ipc/fs.ipc';
import { setupTempDirs } from '../_helpers/tmp-dir';

const tmp = setupTempDirs();

describe('fs:read-for-undo', () => {
  it('普通文件 → 原样字节;文件夹 → dir(不读其下内容)', async () => {
    const root = await tmp.make('continuo-read-undo-');
    await writeFile(join(root, 'a.bin'), Buffer.from([0, 1, 2, 255]));
    await mkdir(join(root, 'd'));
    const file = await readForUndoHandler({ path: join(root, 'a.bin') });
    expect(file.kind).toBe('file');
    expect(file.kind === 'file' && [...file.content]).toEqual([0, 1, 2, 255]);
    expect(await readForUndoHandler({ path: join(root, 'd') })).toEqual({ kind: 'dir' });
  });

  it.skipIf(process.platform === 'win32')('符号链接不跟随 → unsupported(不把链接目标的内容当成它)', async () => {
    const root = await tmp.make('continuo-read-undo-');
    await writeFile(join(root, 'target'), 'secret');
    await symlink(join(root, 'target'), join(root, 'link'));
    expect(await readForUndoHandler({ path: join(root, 'link') })).toEqual({ kind: 'unsupported' });
  });

  it('不存在 → FS_NOT_FOUND', async () => {
    const root = await tmp.make('continuo-read-undo-');
    await expect(readForUndoHandler({ path: join(root, 'nope') })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
  });
});
