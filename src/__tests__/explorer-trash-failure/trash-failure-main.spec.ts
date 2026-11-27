// BDD: explorer-trash-failure / main:移到废纸篓失败按原因映射业务码;永久删除不跟随链接、拒绝根、E2E 限临时目录
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTrashHandler } from '../../../electron/main/ipc/fs.ipc';
import { makeE2eTrashItem } from '../../../electron/main/ipc/fs/e2e-trash';
import { deletePermanently } from '../../../electron/main/ipc/fs/delete-permanently';

const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

let dir: string;
let readonlyDir: string | null = null;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'trash-failure-'));
});
afterEach(() => {
  if (readonlyDir !== null) chmodSync(readonlyDir, 0o755);
  readonlyDir = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('移到废纸篓失败的业务码', () => {
  it.skipIf(!canTestPermissions)('只读目录里的文件(E2E 废纸篓 rename EACCES)→ FS_DENIED,不透传原始串', async () => {
    const ro = path.join(dir, 'ro');
    mkdirSync(ro);
    writeFileSync(path.join(ro, 'a.txt'), 'x');
    chmodSync(ro, 0o555);
    readonlyDir = ro;
    const handler = makeTrashHandler({ trashItem: makeE2eTrashItem(path.join(dir, 'trash')) });
    const err = await handler({ path: path.join(ro, 'a.txt') }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'FS_DENIED' });
    expect((err as Error).message).not.toMatch(/EACCES|permission denied/);
  });

  it.skipIf(!canTestPermissions)('无 errno 的平台失败(shell.trashItem)+ 父目录不可写 → FS_DENIED', async () => {
    const ro = path.join(dir, 'ro');
    mkdirSync(ro);
    writeFileSync(path.join(ro, 'a.txt'), 'x');
    chmodSync(ro, 0o555);
    readonlyDir = ro;
    const handler = makeTrashHandler({
      trashItem: async () => {
        throw new Error('The operation couldn’t be completed.');
      },
    });
    await expect(handler({ path: path.join(ro, 'a.txt') })).rejects.toMatchObject({ code: 'FS_DENIED' });
  });

  it('无 errno 的平台失败 + 父目录可写(卷不支持废纸篓等)→ FS_TRASH_FAILED(renderer 询问是否永久删除)', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    const handler = makeTrashHandler({
      trashItem: async () => {
        throw new Error('Failed to move item to trash');
      },
    });
    await expect(handler({ path: path.join(dir, 'a.txt') })).rejects.toMatchObject({ code: 'FS_TRASH_FAILED' });
  });

  it('目标已不存在 → 仍报 FS_NOT_FOUND', async () => {
    const handler = makeTrashHandler({
      trashItem: async () => {
        throw new Error('gone');
      },
    });
    await expect(handler({ path: path.join(dir, 'missing.txt') })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
  });
});

describe('永久删除', () => {
  const deps = { isWorkspaceRoot: () => false, env: {} };

  it('目录递归删除', async () => {
    mkdirSync(path.join(dir, 'd/sub'), { recursive: true });
    writeFileSync(path.join(dir, 'd/sub/x.txt'), 'x');
    await deletePermanently(path.join(dir, 'd'), deps);
    expect(existsSync(path.join(dir, 'd'))).toBe(false);
  });

  it('符号链接:只删链接本身,不跟随删除目标(目录链接 / 目录内的链接)', async () => {
    const target = path.join(dir, 'target');
    mkdirSync(target);
    writeFileSync(path.join(target, 'keep.txt'), 'x');
    symlinkSync(target, path.join(dir, 'link'));
    await deletePermanently(path.join(dir, 'link'), deps);
    expect(existsSync(path.join(dir, 'link'))).toBe(false);
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true);

    mkdirSync(path.join(dir, 'box'));
    symlinkSync(target, path.join(dir, 'box', 'inner-link'));
    await deletePermanently(path.join(dir, 'box'), deps);
    expect(existsSync(path.join(dir, 'box'))).toBe(false);
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true);
  });

  it('拒绝文件系统根与工作区根', async () => {
    await expect(deletePermanently(path.parse(dir).root, deps)).rejects.toMatchObject({ code: 'FS_DENIED' });
    await expect(
      deletePermanently(dir, { ...deps, isWorkspaceRoot: (p) => p === dir }),
    ).rejects.toMatchObject({ code: 'FS_DENIED' });
    expect(existsSync(dir)).toBe(true);
  });

  it('不存在 → FS_NOT_FOUND', async () => {
    await expect(deletePermanently(path.join(dir, 'missing'), deps)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
  });

  it('E2E 模式:只允许允许根(缺省系统临时目录)之内,之外拒绝且不删', async () => {
    const inside = path.join(dir, 'in.txt');
    writeFileSync(inside, 'x');
    const e2e = { ...deps, env: { CONTINUO_E2E: '1' } };
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'trash-failure-other-'));
    try {
      await expect(deletePermanently(inside, { ...e2e, e2eAllowedRoot: elsewhere })).rejects.toMatchObject({
        code: 'FS_DENIED',
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(existsSync(inside)).toBe(true);
    await deletePermanently(inside, { ...e2e, e2eAllowedRoot: dir });
    expect(existsSync(inside)).toBe(false);
  });
});
