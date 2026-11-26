import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeE2eTrashItem, selectTrashItem } from '../e2e-trash';
import { makeTrashHandler } from '../../fs.ipc';
import { ERROR_CODES } from '../../../../shared/error-codes';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'continuo-e2e-trash-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('makeE2eTrashItem — E2E 模式的「移到废纸篓」只挪进临时目录', () => {
  it('文件被移入 trashDir(按需创建),原路径消失,内容保留', async () => {
    const src = path.join(root, 'ws', 'a.txt');
    await mkdir(path.dirname(src), { recursive: true });
    await writeFile(src, 'hello');
    const trashDir = path.join(root, 'trash');
    await makeE2eTrashItem(trashDir)(src);
    await expect(readFile(src)).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await readdir(trashDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/a\.txt$/);
    expect(await readFile(path.join(trashDir, entries[0]!), 'utf8')).toBe('hello');
  });

  it('同名多次移入不互相覆盖;目录整体移入', async () => {
    const trashDir = path.join(root, 'trash');
    const trash = makeE2eTrashItem(trashDir);
    for (let i = 0; i < 2; i++) {
      const dir = path.join(root, 'ws', 'd');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'x'), String(i));
      await trash(dir);
    }
    expect(await readdir(trashDir)).toHaveLength(2);
  });

  it('跨卷 EXDEV → 退回 cp + rm', async () => {
    const src = path.join(root, 'b.txt');
    await writeFile(src, 'B');
    const trashDir = path.join(root, 'trash');
    const exdev = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    await makeE2eTrashItem(trashDir, { rename: vi.fn(async () => { throw exdev; }) })(src);
    await expect(readFile(src)).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await readdir(trashDir);
    expect(await readFile(path.join(trashDir, entries[0]!), 'utf8')).toBe('B');
  });

  it('经 makeTrashHandler:路径不存在仍报 FS_NOT_FOUND', async () => {
    const handler = makeTrashHandler({ trashItem: makeE2eTrashItem(path.join(root, 'trash')) });
    await expect(handler({ path: path.join(root, 'missing') })).rejects.toMatchObject({
      code: ERROR_CODES.FS_NOT_FOUND,
    });
  });
});

describe('selectTrashItem — 仅 CONTINUO_E2E=1 时替换真实废纸篓', () => {
  it('CONTINUO_E2E=1 → 不调用系统废纸篓', async () => {
    const shellTrash = vi.fn(async () => {});
    const src = path.join(root, 'c.txt');
    await writeFile(src, 'C');
    const userData = path.join(root, 'ud');
    await selectTrashItem({ CONTINUO_E2E: '1' }, () => userData, shellTrash)(src);
    expect(shellTrash).not.toHaveBeenCalled();
    expect(await readdir(path.join(userData, 'e2e-trash'))).toHaveLength(1);
  });

  it('非 E2E → 原样走系统废纸篓', async () => {
    const shellTrash = vi.fn(async () => {});
    await selectTrashItem({}, () => { throw new Error('非 E2E 不应取 userData'); }, shellTrash)('/x/y');
    expect(shellTrash).toHaveBeenCalledWith('/x/y');
  });
});
