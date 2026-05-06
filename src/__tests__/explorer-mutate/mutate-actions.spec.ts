import { describe, it, expect, vi } from 'vitest';
import {
  createNewDir,
  createNewFile,
  removeItems,
  renameItem,
} from '../../panels/Explorer/mutate-actions';
import type { FsApi } from '../../lib/fs/api';
import type { IpcResult } from '../../lib/fs/types';

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });
const fail = (code: string, message = code): IpcResult<never> => ({
  ok: false,
  code,
  message,
});

const makeFs = (overrides: Partial<FsApi> = {}): FsApi => ({
  // 默认成功的桩
  listDir: vi.fn(async () => ok([])),
  readFile: vi.fn(async () => ok('')),
  writeFile: vi.fn(async () => ok(undefined as void)),
  rename: vi.fn(async (_o, n) => ok(`/parent/${n}`)),
  remove: vi.fn(async () => ok(undefined as void)),
  createFile: vi.fn(async (d, n) => ok(`${d}/${n}`)),
  createDir: vi.fn(async (d, n) => ok(`${d}/${n}`)),
  trash: vi.fn(async () => ok(undefined as void)),
  reveal: vi.fn(async () => ok(undefined as void)),
  move: vi.fn(async () => ok(undefined as void)),
  copy: vi.fn(async () => ok(undefined as void)),
  selectDirectory: vi.fn(async () => ok(null)),
  watchDir: vi.fn(async () => ok(undefined as void)),
  unwatchDir: vi.fn(async () => ok(undefined as void)),
  onDirChanged: vi.fn(() => () => {}),
  writeBinary: vi.fn(async () => ok(undefined as void)),
  ...overrides,
});

const makeTree = () => ({
  invalidateChildrenIds: vi.fn(),
});

// ────────────────────────────────────────────────────────────
// renameItem
// ────────────────────────────────────────────────────────────

describe('renameItem', () => {
  it('成功 → 返 { ok, newPath }, 调 fs.rename, 刷父目录', async () => {
    const fs = makeFs({ rename: vi.fn(async () => ok('/work/sub/new.md')) });
    const tree = makeTree();
    const r = await renameItem('/work/sub/old.md', 'new.md', { fs }, tree);
    expect(r).toEqual({ ok: true, newPath: '/work/sub/new.md' });
    expect(fs.rename).toHaveBeenCalledWith('/work/sub/old.md', 'new.md');
    expect(tree.invalidateChildrenIds).toHaveBeenCalledWith('/work/sub');
  });

  it('IpcFail → 返失败, 不刷', async () => {
    const fs = makeFs({ rename: vi.fn(async () => fail('FS_EEXIST', 'exists')) });
    const tree = makeTree();
    const r = await renameItem('/x/a', 'b', { fs }, tree);
    expect(r).toEqual({ ok: false, code: 'FS_EEXIST', message: 'exists' });
    expect(tree.invalidateChildrenIds).not.toHaveBeenCalled();
  });

  it('newName 与 oldName 同名 → 仍调 fs.rename(由 IPC 层判定)', async () => {
    const fs = makeFs();
    const tree = makeTree();
    await renameItem('/x/a', 'a', { fs }, tree);
    expect(fs.rename).toHaveBeenCalledWith('/x/a', 'a');
  });
});

// ────────────────────────────────────────────────────────────
// removeItems
// ────────────────────────────────────────────────────────────

describe('removeItems', () => {
  it('默认 trash: true → 调 fs.trash 而非 fs.remove', async () => {
    const fs = makeFs();
    const tree = makeTree();
    await removeItems(['/x/a'], {}, { fs }, tree);
    expect(fs.trash).toHaveBeenCalledWith('/x/a');
    expect(fs.remove).not.toHaveBeenCalled();
  });

  it('显式 trash: false → 调 fs.remove(硬删)', async () => {
    const fs = makeFs();
    const tree = makeTree();
    await removeItems(['/x/a'], { trash: false }, { fs }, tree);
    expect(fs.remove).toHaveBeenCalledWith('/x/a');
    expect(fs.trash).not.toHaveBeenCalled();
  });

  it('全部成功 → { ok: true }, 父目录批量 invalidate(去重)', async () => {
    const fs = makeFs();
    const tree = makeTree();
    const r = await removeItems(
      ['/x/a', '/x/b', '/y/c'],
      { trash: true },
      { fs },
      tree,
    );
    expect(r).toEqual({ ok: true });
    // /x 出现两次但只 invalidate 一次
    const calls = (tree.invalidateChildrenIds as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(new Set(calls)).toEqual(new Set(['/x', '/y']));
  });

  it('部分失败 → ok:false + failures 列表;成功项的父仍刷', async () => {
    const trash = vi
      .fn<(p: string) => Promise<IpcResult<void>>>()
      .mockResolvedValueOnce(ok(undefined as void))
      .mockResolvedValueOnce(fail('FS_DENIED', 'no perm'))
      .mockResolvedValueOnce(ok(undefined as void));
    const fs = makeFs({ trash });
    const tree = makeTree();
    const r = await removeItems(['/a/x', '/b/y', '/c/z'], {}, { fs }, tree);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toEqual([
        { path: '/b/y', code: 'FS_DENIED', message: 'no perm' },
      ]);
    }
    const invalidatedParents = (
      tree.invalidateChildrenIds as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]);
    // /a 与 /c 成功 → invalidate;/b 失败 → 不 invalidate
    expect(new Set(invalidatedParents)).toEqual(new Set(['/a', '/c']));
  });

  it('paths 空数组 → 不调任何 IPC,直接 ok', async () => {
    const fs = makeFs();
    const tree = makeTree();
    const r = await removeItems([], {}, { fs }, tree);
    expect(r).toEqual({ ok: true });
    expect(fs.trash).not.toHaveBeenCalled();
    expect(fs.remove).not.toHaveBeenCalled();
    expect(tree.invalidateChildrenIds).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// createNewFile
// ────────────────────────────────────────────────────────────

describe('createNewFile', () => {
  it('成功 → { ok, newPath }, 调 fs.createFile, 刷父目录', async () => {
    const fs = makeFs();
    const tree = makeTree();
    const r = await createNewFile('/work', 'a.md', { fs }, tree);
    expect(r).toEqual({ ok: true, newPath: '/work/a.md' });
    expect(fs.createFile).toHaveBeenCalledWith('/work', 'a.md');
    expect(tree.invalidateChildrenIds).toHaveBeenCalledWith('/work');
  });

  it('FS_EEXIST → 透传, 不刷', async () => {
    const fs = makeFs({
      createFile: vi.fn(async () => fail('FS_EEXIST', 'already')),
    });
    const tree = makeTree();
    const r = await createNewFile('/work', 'a.md', { fs }, tree);
    expect(r).toEqual({ ok: false, code: 'FS_EEXIST', message: 'already' });
    expect(tree.invalidateChildrenIds).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// createNewDir
// ────────────────────────────────────────────────────────────

describe('createNewDir', () => {
  it('成功 → { ok, newPath }, 调 fs.createDir, 刷父目录', async () => {
    const fs = makeFs();
    const tree = makeTree();
    const r = await createNewDir('/work', 'docs', { fs }, tree);
    expect(r).toEqual({ ok: true, newPath: '/work/docs' });
    expect(fs.createDir).toHaveBeenCalledWith('/work', 'docs');
    expect(tree.invalidateChildrenIds).toHaveBeenCalledWith('/work');
  });

  it('FS_BAD_NAME → 透传, 不刷', async () => {
    const fs = makeFs({
      createDir: vi.fn(async () => fail('FS_BAD_NAME', 'has slash')),
    });
    const tree = makeTree();
    const r = await createNewDir('/work', 'a/b', { fs }, tree);
    expect(r).toEqual({ ok: false, code: 'FS_BAD_NAME', message: 'has slash' });
    expect(tree.invalidateChildrenIds).not.toHaveBeenCalled();
  });
});
