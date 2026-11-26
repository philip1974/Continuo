// BDD:资源管理器文件操作撤销 / 重做的栈与语义(README 规则 1-9)。用内存假 fs 驱动 file-undo.ts。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_UNDO_LIMIT,
  __resetFileUndoForTest,
  recordFileOp,
  redoFileOp,
  undoFileOp,
  type FileUndoDeps,
} from '../../panels/Explorer/file-undo';

const ROOT = '/ws';
type Entry = { isDir: boolean; mtimeMs: number; size: number; ino: number };
type R<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const ok = <T,>(data: T): R<T> => ({ ok: true, data });
const fail = <T,>(code: string): R<T> => ({ ok: false, code, message: code });
const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';

function makeWorld(initial: Record<string, 'file' | 'dir'>) {
  let ino = 1;
  const files = new Map<string, Entry>();
  const put = (p: string, isDir: boolean): void => {
    files.set(p, { isDir, mtimeMs: 1000, size: 0, ino: ino++ });
  };
  put(ROOT, true);
  for (const [p, kind] of Object.entries(initial)) put(p, kind === 'dir');
  const moveTree = (src: string, dest: string): void => {
    for (const [p, e] of [...files]) {
      if (p === src || p.startsWith(`${src}/`)) {
        files.delete(p);
        files.set(dest + p.slice(src.length), e);
      }
    }
  };
  const has = (p: string): boolean => files.has(p);
  const fs = {
    stat: vi.fn(async (p: string): Promise<R<{ mtimeMs: number; size: number; ino: number }>> => {
      const e = files.get(p);
      return e ? ok({ mtimeMs: e.mtimeMs, size: e.size, ino: e.ino }) : fail('FS_NOT_FOUND');
    }),
    move: vi.fn(async (src: string, dest: string): Promise<R<void>> => {
      if (!has(src)) return fail('FS_NOT_FOUND');
      if (has(dest)) return fail('FS_EEXIST');
      moveTree(src, dest);
      return ok(undefined);
    }),
    rename: vi.fn(async (p: string, name: string): Promise<R<string>> => {
      const dest = `${dirOf(p)}/${name}`;
      if (!has(p)) return fail('FS_NOT_FOUND');
      if (has(dest) && files.get(dest) !== files.get(p)) return fail('FS_EEXIST');
      moveTree(p, dest);
      return ok(dest);
    }),
    createFile: vi.fn(async (dir: string, name: string): Promise<R<string>> => {
      const p = `${dir}/${name}`;
      if (has(p)) return fail('FS_EEXIST');
      put(p, false);
      return ok(p);
    }),
    createDir: vi.fn(async (dir: string, name: string): Promise<R<string>> => {
      const p = `${dir}/${name}`;
      if (has(p)) return fail('FS_EEXIST');
      put(p, true);
      return ok(p);
    }),
    copy: vi.fn(async (src: string, dest: string): Promise<R<void>> => {
      if (!has(src)) return fail('FS_NOT_FOUND');
      if (has(dest)) return fail('FS_EEXIST');
      put(dest, files.get(src)!.isDir);
      return ok(undefined);
    }),
  };
  const moved: Array<[string, string]> = [];
  const refreshed = new Set<string>();
  const confirm = vi.fn(async (_paths: string[], _unsaved: number) => true);
  const trash = vi.fn(async (paths: string[]) => {
    for (const p of paths) for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
    return { removed: paths };
  });
  const deps: FileUndoDeps = {
    fs,
    trash,
    onMoved: (from, to) => moved.push([from, to]),
    refreshDir: (d) => refreshed.add(d),
    confirmUndoCreate: confirm,
    countUnsavedUnder: () => 0,
  };
  return { files, has, put, fs, deps, moved, refreshed, confirm, trash };
}

/** 新建并入栈(同 FolderTree 的新建成功路径)。 */
async function createAndRecord(w: ReturnType<typeof makeWorld>, path: string, type: 'file' | 'dir'): Promise<void> {
  w.put(path, type === 'dir');
  recordFileOp(ROOT, { kind: 'create', entries: [{ path, redo: { type } }] }, w.deps.fs);
  await vi.waitFor(() => expect(w.fs.stat).toHaveBeenCalledWith(path));
}

beforeEach(() => __resetFileUndoForTest());

describe('move(改名 / 移动)撤销与重做', () => {
  it('撤销改名:同目录走 rename 回原名,通知路径移走、刷新目录、定位恢复项;重做再改回', async () => {
    const w = makeWorld({ '/ws/b.txt': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a.txt', to: '/ws/b.txt' }] }, w.deps.fs);

    const r = await undoFileOp(ROOT, w.deps);
    expect(r).toEqual({ status: 'done', reveal: '/ws/a.txt' });
    expect(w.has('/ws/a.txt') && !w.has('/ws/b.txt')).toBe(true);
    expect(w.fs.rename).toHaveBeenCalledWith('/ws/b.txt', 'a.txt');
    expect(w.moved).toEqual([['/ws/b.txt', '/ws/a.txt']]);
    expect(w.refreshed.has('/ws')).toBe(true);

    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/b.txt' });
    expect(w.has('/ws/b.txt') && !w.has('/ws/a.txt')).toBe(true);
    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
  });

  it('撤销批量移动:跨目录走 move,逆序执行,刷新源 / 目标目录', async () => {
    const w = makeWorld({ '/ws/d': 'dir', '/ws/d/x': 'file', '/ws/d/y': 'dir' });
    recordFileOp(
      ROOT,
      { kind: 'move', pairs: [{ from: '/ws/x', to: '/ws/d/x' }, { from: '/ws/y', to: '/ws/d/y' }] },
      w.deps.fs,
    );
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/x' });
    expect(w.fs.move.mock.calls).toEqual([
      ['/ws/d/y', '/ws/y'],
      ['/ws/d/x', '/ws/x'],
    ]);
    expect([...w.refreshed].sort()).toEqual(['/ws', '/ws/d']);
  });

  it('原位置已被占用 → 不动磁盘,失败 FS_EEXIST(path = 被撤销的项,existing = 占位的路径),操作作废', async () => {
    const w = makeWorld({ '/ws/a.txt': 'file', '/ws/b.txt': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a.txt', to: '/ws/b.txt' }] }, w.deps.fs);
    // 提示写「无法撤销对「b.txt」的文件操作:此位置已存在「a.txt」」,不是对占位文件 a.txt 的操作
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({
      status: 'failed',
      code: 'FS_EEXIST',
      path: '/ws/b.txt',
      existing: '/ws/a.txt',
    });
    expect(w.fs.rename).not.toHaveBeenCalled();
    expect(w.fs.move).not.toHaveBeenCalled();
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
  });

  it('多项中任一项已不存在 → 整批不动(前置校验先于任何写盘)', async () => {
    const w = makeWorld({ '/ws/d': 'dir', '/ws/d/x': 'file' });
    recordFileOp(
      ROOT,
      { kind: 'move', pairs: [{ from: '/ws/x', to: '/ws/d/x' }, { from: '/ws/y', to: '/ws/d/y' }] },
      w.deps.fs,
    );
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'failed', code: 'FS_NOT_FOUND', path: '/ws/d/y' });
    expect(w.fs.move).not.toHaveBeenCalled();
    expect(w.has('/ws/d/x')).toBe(true);
  });

  it('原父目录已不存在 → 失败,不动磁盘', async () => {
    const w = makeWorld({ '/ws/x': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/gone/x', to: '/ws/x' }] }, w.deps.fs);
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'failed', code: 'FS_NOT_FOUND', path: '/ws/gone' });
    expect(w.fs.move).not.toHaveBeenCalled();
  });

  it('只差大小写的改名(大小写不敏感盘:原名 stat 到同一 inode)可撤销', async () => {
    const w = makeWorld({ '/ws/README.md': 'file' });
    const real = w.fs.stat.getMockImplementation()!;
    w.fs.stat.mockImplementation(async (p: string) => real(p.toLowerCase() === '/ws/readme.md' ? '/ws/README.md' : p));
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/readme.md', to: '/ws/README.md' }] }, w.deps.fs);
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/readme.md' });
    expect(w.fs.rename).toHaveBeenCalledWith('/ws/README.md', 'readme.md');
  });
});

describe('create(新建 / 粘贴复制 / 外部拖入)撤销与重做', () => {
  it('撤销未改动的新建文件:直接移到废纸篓(不确认),定位父目录;重做重新创建', async () => {
    const w = makeWorld({ '/ws/src': 'dir' });
    await createAndRecord(w, '/ws/src/new.ts', 'file');

    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/src' });
    expect(w.confirm).not.toHaveBeenCalled();
    expect(w.trash).toHaveBeenCalledWith(['/ws/src/new.ts']);
    expect(w.has('/ws/src/new.ts')).toBe(false);

    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/src/new.ts' });
    expect(w.fs.createFile).toHaveBeenCalledWith('/ws/src', 'new.ts');
    expect(w.has('/ws/src/new.ts')).toBe(true);
  });

  it('新建在根目录:撤销后不定位(根不是树里的行)', async () => {
    const w = makeWorld({});
    await createAndRecord(w, '/ws/dir', 'dir');
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: null });
  });

  it('新建后被改过(mtime / size 变化)→ 先确认;取消 → 不删,操作留在撤销栈', async () => {
    const w = makeWorld({});
    await createAndRecord(w, '/ws/n.txt', 'file');
    w.files.get('/ws/n.txt')!.size = 42;
    w.confirm.mockResolvedValueOnce(false);
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'cancelled' });
    expect(w.confirm).toHaveBeenCalledWith(['/ws/n.txt'], 0);
    expect(w.trash).not.toHaveBeenCalled();
    // 仍可再次撤销(这次确认)
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done' });
    expect(w.has('/ws/n.txt')).toBe(false);
  });

  it('有未保存的编辑器 → 先确认,并把未保存编辑器数交给确认框(同删除确认的未保存警告)', async () => {
    const w = makeWorld({});
    await createAndRecord(w, '/ws/n.txt', 'file');
    w.deps.countUnsavedUnder = (paths) => (paths.includes('/ws/n.txt') ? 1 : 0);
    await undoFileOp(ROOT, w.deps);
    expect(w.confirm).toHaveBeenCalledTimes(1);
    expect(w.confirm).toHaveBeenCalledWith(['/ws/n.txt'], 1);
  });

  it('新建项已不存在 → 失败 FS_NOT_FOUND,不调删除', async () => {
    const w = makeWorld({});
    await createAndRecord(w, '/ws/n.txt', 'file');
    w.files.delete('/ws/n.txt');
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'failed', code: 'FS_NOT_FOUND' });
    expect(w.trash).not.toHaveBeenCalled();
  });

  it('粘贴复制:重做时源仍在则重新复制;重做目标位置被占 → 失败不写', async () => {
    const w = makeWorld({ '/ws/a.txt': 'file' });
    w.put('/ws/a copy.txt', false);
    recordFileOp(ROOT, { kind: 'create', entries: [{ path: '/ws/a copy.txt', redo: { type: 'copy', src: '/ws/a.txt' } }] }, w.deps.fs);
    await vi.waitFor(() => expect(w.fs.stat).toHaveBeenCalled());
    await undoFileOp(ROOT, w.deps);
    expect(await redoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done' });
    expect(w.fs.copy).toHaveBeenCalledWith('/ws/a.txt', '/ws/a copy.txt');

    await undoFileOp(ROOT, w.deps);
    w.put('/ws/a copy.txt', false);
    expect(await redoFileOp(ROOT, w.deps)).toMatchObject({
      status: 'failed',
      code: 'FS_EEXIST',
      path: '/ws/a copy.txt',
      existing: '/ws/a copy.txt',
    });
    expect(w.fs.copy).toHaveBeenCalledTimes(1);
  });

  it('外部拖入(不可重做):撤销后重做栈清空', async () => {
    const w = makeWorld({ '/ws/a': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/b', to: '/ws/a' }] }, w.deps.fs);
    w.put('/ws/dropped.png', false);
    recordFileOp(ROOT, { kind: 'create', entries: [{ path: '/ws/dropped.png', redo: null }] }, w.deps.fs);
    await vi.waitFor(() => expect(w.fs.stat).toHaveBeenCalled());
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done' });
    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
    // 更早的操作仍可撤销
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done', reveal: '/ws/b' });
  });
});

describe('栈', () => {
  it('新操作入栈清空重做栈', async () => {
    const w = makeWorld({ '/ws/b': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a', to: '/ws/b' }] }, w.deps.fs);
    await undoFileOp(ROOT, w.deps);
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/x', to: '/ws/y' }] }, w.deps.fs);
    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
  });

  it(`上限 ${FILE_UNDO_LIMIT}:超出丢最旧`, async () => {
    const w = makeWorld({});
    for (let i = 0; i <= FILE_UNDO_LIMIT; i++) {
      w.put(`/ws/f${i}`, false);
      recordFileOp(ROOT, { kind: 'move', pairs: [{ from: `/ws/g${i}`, to: `/ws/f${i}` }] }, w.deps.fs);
    }
    for (let i = 0; i < FILE_UNDO_LIMIT; i++) expect((await undoFileOp(ROOT, w.deps)).status).toBe('done');
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
    expect(w.has('/ws/f0')).toBe(true);
  });

  it('按工作区根分栈', async () => {
    const w = makeWorld({ '/ws/b': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a', to: '/ws/b' }] }, w.deps.fs);
    expect(await undoFileOp('/other', w.deps)).toEqual({ status: 'empty' });
    expect((await undoFileOp(ROOT, w.deps)).status).toBe('done');
  });

  it('执行中再次撤销 → busy,不并发', async () => {
    const w = makeWorld({ '/ws/b': 'file', '/ws/d': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/c', to: '/ws/d' }] }, w.deps.fs);
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a', to: '/ws/b' }] }, w.deps.fs);
    const first = undoFileOp(ROOT, w.deps);
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'busy' });
    expect((await first).status).toBe('done');
    expect(w.has('/ws/d')).toBe(true);
  });
});
