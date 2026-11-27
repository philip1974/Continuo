// BDD:资源管理器文件操作撤销 / 重做的栈与语义(README 规则 1-9,删除的撤销见规则 3、嵌套新建见规则 5、8)。用内存假 fs 驱动 file-undo.ts。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_UNDO_LIMIT,
  MAX_UNDO_DELETE_TOTAL_BYTES,
  __resetFileUndoForTest,
  captureForUndo,
  deleteOpFor,
  recordFileOp,
  redoFileOp,
  undoFileOp,
  type FileUndoDeps,
} from '../../panels/Explorer/file-undo';

const ROOT = '/ws';
type Entry = { isDir: boolean; mtimeMs: number; size: number; ino: number; content?: Uint8Array; link?: boolean };
const MAX_UNDO_FILE_BYTES = 5_000_000;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (u: Uint8Array | undefined): string => new TextDecoder().decode(u);
type R<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const ok = <T,>(data: T): R<T> => ({ ok: true, data });
const fail = <T,>(code: string): R<T> => ({ ok: false, code, message: code });
const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';

function makeWorld(initial: Record<string, 'file' | 'dir'>) {
  let ino = 1;
  const files = new Map<string, Entry>();
  const put = (p: string, isDir: boolean, content?: Uint8Array): void => {
    files.set(p, { isDir, mtimeMs: 1000, size: content?.length ?? 0, ino: ino++, ...(content && { content }) });
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
  // 同 main createFile / createDir:name 可带中间目录(`a/b/c.ts`),缺的逐级建;created = 本次新建的最上层项。
  const createChain = async (dir: string, name: string, isDir: boolean): Promise<R<{ path: string; created: string }>> => {
    const segs = name.split('/');
    const target = `${dir}/${name}`;
    if (has(target)) return fail('FS_EEXIST');
    let cur = dir;
    let created: string | null = null;
    segs.forEach((seg, i) => {
      cur = `${cur}/${seg}`;
      if (!has(cur)) {
        put(cur, i < segs.length - 1 || isDir);
        created ??= cur;
      }
    });
    return ok({ path: cur, created: created ?? cur });
  };
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
    createFile: vi.fn(async (dir: string, name: string) => createChain(dir, name, false)),
    createDir: vi.fn(async (dir: string, name: string) => createChain(dir, name, true)),
    copy: vi.fn(async (src: string, dest: string): Promise<R<void>> => {
      if (!has(src)) return fail('FS_NOT_FOUND');
      if (has(dest)) return fail('FS_EEXIST');
      put(dest, files.get(src)!.isDir);
      return ok(undefined);
    }),
    // 同 main fs:read-for-undo(lstat,不跟随链接)
    readForUndo: vi.fn(async (p: string) => {
      const e = files.get(p);
      if (!e) return fail<never>('FS_NOT_FOUND');
      if (e.isDir) return ok({ kind: 'dir' as const });
      if (e.link) return ok({ kind: 'unsupported' as const });
      if (e.size > MAX_UNDO_FILE_BYTES) return ok({ kind: 'tooLarge' as const });
      return ok({ kind: 'file' as const, content: e.content ?? new Uint8Array() });
    }),
    // 同 main fs:write-binary(原子写,同名覆盖)
    writeBinary: vi.fn(async (p: string, content: Uint8Array): Promise<R<void>> => {
      if (!has(dirOf(p))) return fail('FS_NOT_FOUND');
      put(p, false, content);
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
function createAndRecord(w: ReturnType<typeof makeWorld>, path: string, type: 'file' | 'dir'): void {
  w.put(path, type === 'dir');
  recordFileOp(ROOT, { kind: 'create', entries: [{ path, redo: { type } }] });
}

beforeEach(() => __resetFileUndoForTest());

describe('move(改名 / 移动)撤销与重做', () => {
  it('撤销改名:同目录走 rename 回原名,通知路径移走、刷新目录、定位恢复项;重做再改回', async () => {
    const w = makeWorld({ '/ws/b.txt': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a.txt', to: '/ws/b.txt' }] });

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
      { kind: 'move', pairs: [{ from: '/ws/x', to: '/ws/d/x' }, { from: '/ws/y', to: '/ws/d/y' }] }
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
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a.txt', to: '/ws/b.txt' }] });
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
      { kind: 'move', pairs: [{ from: '/ws/x', to: '/ws/d/x' }, { from: '/ws/y', to: '/ws/d/y' }] }
    );
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'failed', code: 'FS_NOT_FOUND', path: '/ws/d/y' });
    expect(w.fs.move).not.toHaveBeenCalled();
    expect(w.has('/ws/d/x')).toBe(true);
  });

  it('原父目录已不存在 → 失败,不动磁盘', async () => {
    const w = makeWorld({ '/ws/x': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/gone/x', to: '/ws/x' }] });
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'failed', code: 'FS_NOT_FOUND', path: '/ws/gone' });
    expect(w.fs.move).not.toHaveBeenCalled();
  });

  it('只差大小写的改名(大小写不敏感盘:原名 stat 到同一 inode)可撤销', async () => {
    const w = makeWorld({ '/ws/README.md': 'file' });
    const real = w.fs.stat.getMockImplementation()!;
    w.fs.stat.mockImplementation(async (p: string) => real(p.toLowerCase() === '/ws/readme.md' ? '/ws/README.md' : p));
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/readme.md', to: '/ws/README.md' }] });
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/readme.md' });
    expect(w.fs.rename).toHaveBeenCalledWith('/ws/README.md', 'readme.md');
  });
});

describe('create(新建 / 粘贴复制 / 外部拖入)撤销与重做', () => {
  it('撤销新建文件(即使没改过)也先确认(VSCode confirmBeforeUndo),确认后移到废纸篓、定位父目录;重做重新创建', async () => {
    const w = makeWorld({ '/ws/src': 'dir' });
    createAndRecord(w, '/ws/src/new.ts', 'file');

    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/src' });
    expect(w.confirm).toHaveBeenCalledTimes(1);
    expect(w.confirm).toHaveBeenCalledWith(['/ws/src/new.ts'], 0);
    expect(w.trash).toHaveBeenCalledWith(['/ws/src/new.ts']);
    expect(w.has('/ws/src/new.ts')).toBe(false);

    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/src/new.ts' });
    expect(w.fs.createFile).toHaveBeenCalledWith('/ws/src', 'new.ts');
    expect(w.has('/ws/src/new.ts')).toBe(true);
  });

  it('新建在根目录:撤销后不定位(根不是树里的行)', async () => {
    const w = makeWorld({});
    createAndRecord(w, '/ws/dir', 'dir');
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: null });
  });

  it('确认框取消 → 不删,操作留在撤销栈', async () => {
    const w = makeWorld({});
    createAndRecord(w, '/ws/n.txt', 'file');
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
    createAndRecord(w, '/ws/n.txt', 'file');
    w.deps.countUnsavedUnder = (paths) => (paths.includes('/ws/n.txt') ? 1 : 0);
    await undoFileOp(ROOT, w.deps);
    expect(w.confirm).toHaveBeenCalledTimes(1);
    expect(w.confirm).toHaveBeenCalledWith(['/ws/n.txt'], 1);
  });

  it('新建项已不存在 → 失败 FS_NOT_FOUND,不调删除', async () => {
    const w = makeWorld({});
    createAndRecord(w, '/ws/n.txt', 'file');
    w.files.delete('/ws/n.txt');
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'failed', code: 'FS_NOT_FOUND' });
    expect(w.trash).not.toHaveBeenCalled();
  });

  it('粘贴复制:重做时源仍在则重新复制;重做目标位置被占 → 失败不写', async () => {
    const w = makeWorld({ '/ws/a.txt': 'file' });
    w.put('/ws/a copy.txt', false);
    recordFileOp(ROOT, { kind: 'create', entries: [{ path: '/ws/a copy.txt', redo: { type: 'copy', src: '/ws/a.txt' } }] });
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done' });
    // 撤销粘贴复制同样会把文件移进废纸篓 → 先确认
    expect(w.confirm).toHaveBeenCalledWith(['/ws/a copy.txt'], 0);
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
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/b', to: '/ws/a' }] });
    w.put('/ws/dropped.png', false);
    recordFileOp(ROOT, { kind: 'create', entries: [{ path: '/ws/dropped.png', redo: null }] });
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done' });
    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
    // 更早的操作仍可撤销
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done', reveal: '/ws/b' });
  });
});

describe('删除的撤销(VSCode DeleteOperation:删除前读回内容,撤销在原位置重建)', () => {
  /** 同 FolderTree 的删除:先读回,再删,按实际删掉的项入栈。 */
  async function deleteAndRecord(w: ReturnType<typeof makeWorld>, paths: string[]): Promise<void> {
    const backup = await captureForUndo(w.fs, paths);
    const { removed } = await w.trash(paths);
    recordFileOp(ROOT, deleteOpFor(backup, removed));
  }

  it('撤销删除文件 → 原位置按原内容重建、定位到它,不确认、不调废纸篓;重做 → 再次移到废纸篓,可再撤销', async () => {
    const w = makeWorld({});
    w.put('/ws/a.ts', false, bytes('hello'));
    await deleteAndRecord(w, ['/ws/a.ts']);
    expect(w.has('/ws/a.ts')).toBe(false);
    w.trash.mockClear();

    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/a.ts' });
    expect(text(w.files.get('/ws/a.ts')?.content)).toBe('hello');
    expect(w.refreshed.has('/ws')).toBe(true);
    expect(w.confirm).not.toHaveBeenCalled();
    expect(w.trash).not.toHaveBeenCalled();

    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: null });
    expect(w.trash).toHaveBeenCalledWith(['/ws/a.ts']);
    expect(w.has('/ws/a.ts')).toBe(false);
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done', reveal: '/ws/a.ts' });
    expect(text(w.files.get('/ws/a.ts')?.content)).toBe('hello');
  });

  it('删除不再挡住更早的操作:撤销删除之后,下一次 ⌘Z 撤销更早的改名', async () => {
    const w = makeWorld({ '/ws/b': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a', to: '/ws/b' }] });
    w.put('/ws/x', false, bytes('x'));
    await deleteAndRecord(w, ['/ws/x']);

    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done', reveal: '/ws/x' });
    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done', reveal: '/ws/a' });
    expect(w.has('/ws/a') && w.has('/ws/x')).toBe(true);
  });

  it('原位置已被占 → 失败(此位置已存在),不覆盖,该操作出栈', async () => {
    const w = makeWorld({});
    w.put('/ws/a.ts', false, bytes('old'));
    await deleteAndRecord(w, ['/ws/a.ts']);
    w.put('/ws/a.ts', false, bytes('new'));

    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'failed', path: '/ws/a.ts', existing: '/ws/a.ts' });
    expect(text(w.files.get('/ws/a.ts')?.content)).toBe('new');
    expect(w.fs.writeBinary).not.toHaveBeenCalled();
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
  });

  it('多项删除:任一原位置被占 → 一项都不重建', async () => {
    const w = makeWorld({});
    w.put('/ws/a', false, bytes('a'));
    w.put('/ws/b', false, bytes('b'));
    await deleteAndRecord(w, ['/ws/a', '/ws/b']);
    w.put('/ws/b', false, bytes('other'));

    expect(await undoFileOp(ROOT, w.deps)).toMatchObject({ status: 'failed', existing: '/ws/b' });
    expect(w.has('/ws/a')).toBe(false);
  });

  it('文件夹:撤销只重建空文件夹(VSCode 同),并报告 emptyFolders 供提示「内容可从废纸篓找回」', async () => {
    const w = makeWorld({ '/ws/dir': 'dir' });
    w.put('/ws/dir/inner.ts', false, bytes('inner'));
    await deleteAndRecord(w, ['/ws/dir', '/ws/dir/inner.ts']);

    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/dir', emptyFolders: ['/ws/dir'] });
    expect(w.files.get('/ws/dir')?.isDir).toBe(true);
    expect(w.has('/ws/dir/inner.ts')).toBe(false);
    // 嵌套的项并入上级,只读回上级
    expect(w.fs.readForUndo).toHaveBeenCalledTimes(1);
  });

  it('超过 5MB 的文件、符号链接:删除照常,撤销不重建它,报告 notRestored;其余照常重建', async () => {
    const w = makeWorld({});
    w.files.set('/ws/big.bin', { isDir: false, mtimeMs: 1, size: MAX_UNDO_FILE_BYTES + 1, ino: 99 });
    w.files.set('/ws/link', { isDir: false, mtimeMs: 1, size: 3, ino: 98, link: true });
    w.put('/ws/small.ts', false, bytes('s'));
    await deleteAndRecord(w, ['/ws/big.bin', '/ws/link', '/ws/small.ts']);

    expect(await undoFileOp(ROOT, w.deps)).toEqual({
      status: 'done',
      reveal: '/ws/small.ts',
      notRestored: ['/ws/big.bin', '/ws/link'],
    });
    expect(w.has('/ws/big.bin') || w.has('/ws/link')).toBe(false);
    expect(text(w.files.get('/ws/small.ts')?.content)).toBe('s');
  });

  it('读回失败的项同样不重建;一次删除读回总量超过上限的部分按过大处理', async () => {
    const w = makeWorld({});
    w.put('/ws/a', false, bytes('a'));
    w.fs.readForUndo.mockRejectedValueOnce(new Error('ipc gone'));
    expect(await captureForUndo(w.fs, ['/ws/a'])).toEqual([{ path: '/ws/a', type: 'skipped' }]);

    const big = new Uint8Array(MAX_UNDO_DELETE_TOTAL_BYTES - 1);
    w.put('/ws/p', false, big);
    w.put('/ws/q', false, bytes('qq'));
    // 假 fs 的单文件上限按真实值;这里只看总量:p 占满后 q 放不下
    w.files.get('/ws/p')!.size = 1;
    const entries = await captureForUndo(w.fs, ['/ws/p', '/ws/q']);
    expect(entries.map((e) => e.type)).toEqual(['file', 'skipped']);
  });

  it('只记实际删掉的项:删除失败的项不入栈;一项都没删掉 → 不入栈', async () => {
    const w = makeWorld({});
    w.put('/ws/a', false, bytes('a'));
    w.put('/ws/b', false, bytes('b'));
    const backup = await captureForUndo(w.fs, ['/ws/a', '/ws/b']);
    w.files.delete('/ws/a');
    recordFileOp(ROOT, deleteOpFor(backup, ['/ws/a']));
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/a' });
    expect(w.fs.writeBinary).toHaveBeenCalledTimes(1);

    recordFileOp(ROOT, deleteOpFor(backup, []));
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
  });

  it('删除清空重做栈', async () => {
    const w = makeWorld({ '/ws/b': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a', to: '/ws/b' }] });
    await undoFileOp(ROOT, w.deps);
    w.put('/ws/x', false, bytes('x'));
    await deleteAndRecord(w, ['/ws/x']);
    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
  });
});

describe('一次输入嵌套路径的新建(a/b/c.ts)', () => {
  it('撤销删最上层新建目录(覆盖整条链),已存在的中间目录不动;重做按原样逐级重建', async () => {
    const w = makeWorld({ '/ws/src': 'dir' });
    // 新建 src/na/nb/nc.ts:src 已存在,na、nb 是本次新建 → 记录 path = 最上层新建项,rest = 余下的段
    const r = await w.fs.createFile('/ws/src', 'na/nb/nc.ts');
    expect(r).toEqual({ ok: true, data: { path: '/ws/src/na/nb/nc.ts', created: '/ws/src/na' } });
    recordFileOp(ROOT, { kind: 'create', entries: [{ path: '/ws/src/na', redo: { type: 'file', rest: 'nb/nc.ts' } }] });

    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'done', reveal: '/ws/src' });
    expect(w.confirm).toHaveBeenCalledWith(['/ws/src/na'], 0);
    expect(w.trash).toHaveBeenCalledWith(['/ws/src/na']);
    expect(w.has('/ws/src/na')).toBe(false);
    expect(w.has('/ws/src/na/nb/nc.ts')).toBe(false);
    expect(w.has('/ws/src')).toBe(true);

    expect(await redoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done' });
    expect(w.fs.createFile).toHaveBeenLastCalledWith('/ws/src', 'na/nb/nc.ts');
    expect(w.has('/ws/src/na/nb/nc.ts')).toBe(true);
  });

  it('新建文件夹 a/b:重做走 createDir 逐级重建', async () => {
    const w = makeWorld({});
    await w.fs.createDir('/ws', 'a/b');
    recordFileOp(ROOT, { kind: 'create', entries: [{ path: '/ws/a', redo: { type: 'dir', rest: 'b' } }] });
    await undoFileOp(ROOT, w.deps);
    expect(w.has('/ws/a')).toBe(false);
    expect(await redoFileOp(ROOT, w.deps)).toMatchObject({ status: 'done' });
    expect(w.fs.createDir).toHaveBeenLastCalledWith('/ws', 'a/b');
    expect(w.has('/ws/a/b')).toBe(true);
  });
});

describe('栈', () => {
  it('新操作入栈清空重做栈', async () => {
    const w = makeWorld({ '/ws/b': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a', to: '/ws/b' }] });
    await undoFileOp(ROOT, w.deps);
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/x', to: '/ws/y' }] });
    expect(await redoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
  });

  it(`上限 ${FILE_UNDO_LIMIT}:超出丢最旧`, async () => {
    const w = makeWorld({});
    for (let i = 0; i <= FILE_UNDO_LIMIT; i++) {
      w.put(`/ws/f${i}`, false);
      recordFileOp(ROOT, { kind: 'move', pairs: [{ from: `/ws/g${i}`, to: `/ws/f${i}` }] });
    }
    for (let i = 0; i < FILE_UNDO_LIMIT; i++) expect((await undoFileOp(ROOT, w.deps)).status).toBe('done');
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'empty' });
    expect(w.has('/ws/f0')).toBe(true);
  });

  it('按工作区根分栈', async () => {
    const w = makeWorld({ '/ws/b': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a', to: '/ws/b' }] });
    expect(await undoFileOp('/other', w.deps)).toEqual({ status: 'empty' });
    expect((await undoFileOp(ROOT, w.deps)).status).toBe('done');
  });

  it('执行中再次撤销 → busy,不并发', async () => {
    const w = makeWorld({ '/ws/b': 'file', '/ws/d': 'file' });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/c', to: '/ws/d' }] });
    recordFileOp(ROOT, { kind: 'move', pairs: [{ from: '/ws/a', to: '/ws/b' }] });
    const first = undoFileOp(ROOT, w.deps);
    expect(await undoFileOp(ROOT, w.deps)).toEqual({ status: 'busy' });
    expect((await first).status).toBe('done');
    expect(w.has('/ws/d')).toBe(true);
  });
});
