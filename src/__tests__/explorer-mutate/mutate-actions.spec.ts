import { normalizeLeafNameInput, renameTarget } from '../../panels/Explorer/path-utils';
import { describe, it, expect, vi } from 'vitest';
import {
  createNewDir,
  createNewFile,
  removeItems,
  renameItem,
} from '../../panels/Explorer/mutate-actions';
import type { FsApi } from '../../lib/fs/api';
import type { IpcResult } from '../../lib/fs/types';
import { flushMacrotasks } from '../_helpers/async';

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });
const fail = (code: string, message = code): IpcResult<never> => ({
  ok: false,
  code,
  message,
});

const makeFs = (overrides: Partial<FsApi> = {}): FsApi => ({
  // 默认成功的桩
  listDir: vi.fn(async () => ok([])),
  scanFiles: vi.fn(async () => ok({ entries: [], skippedDirs: 0 })),
  readFile: vi.fn(async () => ok('')),
  readImage: vi.fn(async () => ok({ dataUrl: '', size: 0 })),
  writeFile: vi.fn(async () => ok(undefined)),
  showSaveDialog: vi.fn(async () => ok(null)),
  stat: vi.fn(async () => ok({ mtimeMs: 0, size: 0, ino: 0 })),
  rename: vi.fn(async (_o, n) => ok(`/parent/${n}`)),
  createFile: vi.fn(async (d, n) => ok({ path: `${d}/${n}`, created: `${d}/${n}` })),
  createDir: vi.fn(async (d, n) => ok({ path: `${d}/${n}`, created: `${d}/${n}` })),
  trash: vi.fn(async () => ok(undefined as void)),
  deletePermanently: vi.fn(async () => ok(undefined as void)),
  reveal: vi.fn(async () => ok(undefined as void)),
  move: vi.fn(async () => ok(undefined as void)),
  copy: vi.fn(async () => ok(undefined as void)),
  selectDirectory: vi.fn(async () => ok(null)),
  watchDir: vi.fn(async () => ok(undefined as void)),
  unwatchDir: vi.fn(async () => ok(undefined as void)),
  watchFile: vi.fn(async () => ok(undefined as void)),
  unwatchFile: vi.fn(async () => ok(undefined as void)),
  onDirChanged: vi.fn(() => () => {}),
  onWatchLost: vi.fn(() => () => {}),
  onRootPresenceChanged: vi.fn(() => () => {}),
  writeBinary: vi.fn(async () => ok(undefined as void)),
  readForUndo: vi.fn(async () => ok({ kind: 'unsupported' as const })),
  saveDocumentImage: vi.fn(async () => ok('')),
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

  it('IPC reject → 返结构化失败(同 createNewFile / createNewDir),不刷、不抛', async () => {
    const fs = makeFs({
      rename: vi.fn(async () => {
        throw Object.assign(new Error('ipc down'), { code: 'EIO' });
      }),
    });
    const tree = makeTree();
    const r = await renameItem('/x/a', 'b', { fs }, tree);
    expect(r).toEqual({ ok: false, code: 'EIO', message: 'ipc down' });
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
  it('failures 按 paths.length 预分配收集,不通过 failures.push 扩容', async () => {
    const fs = makeFs({
      trash: vi.fn(async () => fail('FS_DENIED', 'no perm')),
    });
    const tree = makeTree();

    const r = await removeItems(['/a/x', '/b/y'], { fs }, tree);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toHaveLength(2);
    }
    expect(removeItems.toString()).not.toContain('failures.push(');
  });

  it('调 fs.trash(移到系统回收站)', async () => {
    const fs = makeFs();
    const tree = makeTree();
    await removeItems(['/x/a'], { fs }, tree);
    expect(fs.trash).toHaveBeenCalledWith('/x/a');
  });

  it('全部成功 → { ok: true }, 父目录批量 invalidate(去重)', async () => {
    const fs = makeFs();
    const tree = makeTree();
    const r = await removeItems(
      ['/x/a', '/x/b', '/y/c'],
      { fs },
      tree,
    );
    expect(r).toEqual({ ok: true, removed: ['/x/a', '/x/b', '/y/c'] });
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
    const r = await removeItems(['/a/x', '/b/y', '/c/z'], { fs }, tree);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toEqual([
        { path: '/b/y', code: 'FS_DENIED', message: 'no perm' },
      ]);
    }
    expect(r.removed).toEqual(['/a/x', '/c/z']);
    const invalidatedParents = (
      tree.invalidateChildrenIds as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]);
    // /a 与 /c 成功 → invalidate;/b 失败 → 不 invalidate
    expect(new Set(invalidatedParents)).toEqual(new Set(['/a', '/c']));
  });

  it('确认期间已被外部删除(FS_NOT_FOUND / ENOENT,含 reject)→ 当作已删除:计入 removed、父目录刷新,不报失败', async () => {
    const trash = vi
      .fn<(p: string) => Promise<IpcResult<void>>>()
      .mockResolvedValueOnce(fail('FS_NOT_FOUND', 'not found: /a/x'))
      .mockResolvedValueOnce(fail('ENOENT', 'ENOENT'))
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'FS_NOT_FOUND' }));
    const fs = makeFs({ trash });
    const tree = makeTree();
    const r = await removeItems(['/a/x', '/b/y', '/c/z'], { fs }, tree);
    expect(r).toEqual({ ok: true, removed: ['/a/x', '/b/y', '/c/z'] });
    const invalidatedParents = (
      tree.invalidateChildrenIds as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]);
    expect(new Set(invalidatedParents)).toEqual(new Set(['/a', '/b', '/c']));
  });

  it('paths 空数组 → 不调任何 IPC,直接 ok', async () => {
    const fs = makeFs();
    const tree = makeTree();
    const r = await removeItems([], { fs }, tree);
    expect(r).toEqual({ ok: true, removed: [] });
    expect(fs.trash).not.toHaveBeenCalled();
    expect(tree.invalidateChildrenIds).not.toHaveBeenCalled();
  });

  // a11y(A138,A137 同族):trash/remove 的 IPC reject 须归类到 failures,不能让 removeItems
  // 整体 reject(否则调用点 onTrash 漏报 + unhandled rejection)。
  it('trash reject → 归类到 failures(不 reject),成功项的父仍刷', async () => {
    const trash = vi
      .fn<(p: string) => Promise<IpcResult<void>>>()
      .mockResolvedValueOnce(ok(undefined as void))
      .mockRejectedValueOnce(Object.assign(new Error('ipc down'), { code: 'EIO' }))
      .mockResolvedValueOnce(ok(undefined as void));
    const fs = makeFs({ trash });
    const tree = makeTree();
    const r = await removeItems(['/a/x', '/b/y', '/c/z'], { fs }, tree);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failures).toEqual([
        { path: '/b/y', code: 'EIO', message: 'ipc down' },
      ]);
    }
    const invalidatedParents = (
      tree.invalidateChildrenIds as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]);
    expect(new Set(invalidatedParents)).toEqual(new Set(['/a', '/c']));
  });

  // perf:批量删除此前逐项 await trash/remove(N 次串行 IPC 往返)。改为有界并发(≤4),
  // outermostPaths 已保证互不包含,并发删除安全;removed/failures 仍按输入顺序汇总。
  it('有界并发删除:在途数 >1 且 ≤4;乱序完成时 removed/failures 仍按输入顺序', async () => {
    let inFlight = 0;
    let peak = 0;
    const pending = new Map<string, (r: IpcResult<void>) => void>();
    const trash = vi.fn(
      (p: string) =>
        new Promise<IpcResult<void>>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          pending.set(p, (r) => {
            inFlight -= 1;
            pending.delete(p);
            resolve(r);
          });
        }),
    );
    const fs = makeFs({ trash });
    const tree = makeTree();
    const paths = Array.from({ length: 10 }, (_, i) => `/d${i}/f`);
    const done = removeItems(paths, { fs }, tree);
    for (let n = 0; n < 200 && (pending.size > 0 || trash.mock.calls.length < 10); n++) {
      await flushMacrotasks(1);
      // 倒序放行在途项(后发先完成);d3、d6 失败
      const last = [...pending.keys()].pop();
      if (last) pending.get(last)!(/d[36]\//.test(last) ? fail('FS_DENIED') : ok(undefined as void));
    }
    const r = await done;
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(r.removed).toEqual(paths.filter((p) => !/d[36]\//.test(p)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures.map((f) => f.path)).toEqual(['/d3/f', '/d6/f']);
    const invalidated = (tree.invalidateChildrenIds as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(invalidated).toEqual(r.removed.map((p) => p.slice(0, p.lastIndexOf('/'))));
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
    expect(r).toEqual({ ok: true, newPath: '/work/a.md', created: '/work/a.md' });
    expect(fs.createFile).toHaveBeenCalledWith('/work', 'a.md');
    expect(tree.invalidateChildrenIds).toHaveBeenCalledWith('/work');
  });

  it('嵌套路径:返回 created(本次新建的最上层项),刷新它所在的目录', async () => {
    const fs = makeFs({
      createFile: vi.fn(async () => ok({ path: '/work/sub/na/nb/c.ts', created: '/work/sub/na' })),
    });
    const tree = makeTree();
    const r = await createNewFile('/work', 'sub/na/nb/c.ts', { fs }, tree);
    expect(r).toEqual({ ok: true, newPath: '/work/sub/na/nb/c.ts', created: '/work/sub/na' });
    expect(tree.invalidateChildrenIds).toHaveBeenCalledWith('/work/sub');
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

  // a11y(A139,A138 同族):createFile reject 归类为 ActionFail(不 reject),code 取 err.code ?? EXCEPTION。
  it('createFile reject(带 code)→ ActionFail, 不刷', async () => {
    const fs = makeFs({
      createFile: vi.fn(async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }),
    });
    const tree = makeTree();
    const r = await createNewFile('/work', 'a.md', { fs }, tree);
    expect(r).toEqual({ ok: false, code: 'ENOSPC', message: 'disk full' });
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
    expect(r).toEqual({ ok: true, newPath: '/work/docs', created: '/work/docs' });
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

  // a11y(A139):createDir reject(无 code)→ ActionFail code=EXCEPTION,不 reject。
  it('createDir reject(无 code)→ ActionFail code=EXCEPTION, 不刷', async () => {
    const fs = makeFs({
      createDir: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const tree = makeTree();
    const r = await createNewDir('/work', 'docs', { fs }, tree);
    expect(r).toEqual({ ok: false, code: 'EXCEPTION', message: 'boom' });
    expect(tree.invalidateChildrenIds).not.toHaveBeenCalled();
  });
});

// 新建与重命名共用同一输入规范化(此前新建 trim + 空值取消,重命名原样提交):F2 不改名直接回车 → headless-tree
// 仍以原名调 onRename → 改名到自身「成功」→ 剪贴板 prune 掉该路径(剪切标记消失);空值弹 FS_BAD_NAME;
// 带首尾空格被拒。重命名规范化后为空或与原名相同 → 不发 IPC。
describe('normalizeLeafNameInput / renameTarget', () => {
  it('去首尾空白;空值 → null', () => {
    expect(normalizeLeafNameInput('  foo.md ')).toBe('foo.md');
    expect(normalizeLeafNameInput('   ')).toBeNull();
  });

  it('重命名:未改名 / 空值 → null;改名(含仅大小写)→ 规范化后的新名', () => {
    expect(renameTarget('/w/a.md', 'a.md')).toBeNull();
    expect(renameTarget('/w/a.md', ' a.md ')).toBeNull();
    expect(renameTarget('/w/a.md', '')).toBeNull();
    expect(renameTarget('/w/a.md', ' b.md ')).toBe('b.md');
    expect(renameTarget('/w/a.md', 'A.md')).toBe('A.md');
    // 原名本身带前导空格(合法名):不改直接回车 → null,不得被 trim 成另一个名字静默改名。
    expect(renameTarget('/w/ a.md', ' a.md')).toBeNull();
  });
});

