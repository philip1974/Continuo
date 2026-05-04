import { describe, it, expect, vi } from 'vitest';
import {
  partitionDropItems,
  performDrop,
  resolveDropTarget,
  type DropFsApi,
  type DropTargetEntry,
} from '../../panels/Explorer/drop-handlers';
import type { IpcResult } from '../../lib/fs/types';

const ok = (): IpcResult<void> => ({ ok: true, data: undefined });
const fail = (code: string, message = code): IpcResult<never> => ({
  ok: false,
  code,
  message,
});

const dir = (path: string): DropTargetEntry => ({ path, isDirectory: true });
const file = (path: string): DropTargetEntry => ({ path, isDirectory: false });

// ────────────────────────────────────────────────────────────
// resolveDropTarget
// ────────────────────────────────────────────────────────────

describe('resolveDropTarget', () => {
  it('null target → root', () => {
    expect(resolveDropTarget(null, '/work')).toBe('/work');
  });

  it('folder target → folder.path', () => {
    expect(resolveDropTarget(dir('/work/sub'), '/work')).toBe('/work/sub');
  });

  it('file target → dirname(file.path)', () => {
    expect(resolveDropTarget(file('/work/sub/a.md'), '/work')).toBe('/work/sub');
  });
});

// ────────────────────────────────────────────────────────────
// partitionDropItems
// ────────────────────────────────────────────────────────────

interface FakeItem {
  kind: 'file' | 'string';
  isDir: boolean;
  name: string;
}

function makeItemList(items: FakeItem[]): DataTransferItemList {
  // 模拟 DataTransferItemList(只用我们关心的几个方法)
  const arr = items.map((it) => ({
    kind: it.kind,
    type: '',
    getAsFile: (): File | null =>
      it.kind === 'file' && !it.isDir
        ? new File([new Uint8Array([1, 2, 3])], it.name)
        : null,
    getAsString: () => {},
    webkitGetAsEntry: () => ({ isDirectory: it.isDir, name: it.name }),
  }));
  // DataTransferItemList 是 array-like with length + index
  const list = arr as unknown as DataTransferItemList;
  Object.defineProperty(list, 'length', { value: arr.length });
  return list;
}

describe('partitionDropItems', () => {
  it('null → 空', () => {
    const r = partitionDropItems(null);
    expect(r.files).toEqual([]);
    expect(r.skippedDirs).toEqual([]);
  });

  it('单文件 kind=file 非目录 → files 1', () => {
    const items = makeItemList([{ kind: 'file', isDir: false, name: 'a.md' }]);
    const r = partitionDropItems(items);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.name).toBe('a.md');
    expect(r.skippedDirs).toEqual([]);
  });

  it('文件夹被 skip 收集到 skippedDirs', () => {
    const items = makeItemList([
      { kind: 'file', isDir: false, name: 'x.txt' },
      { kind: 'file', isDir: true, name: 'mydir' },
      { kind: 'file', isDir: false, name: 'y.txt' },
    ]);
    const r = partitionDropItems(items);
    expect(r.files.map((f) => f.name)).toEqual(['x.txt', 'y.txt']);
    expect(r.skippedDirs).toEqual(['mydir']);
  });

  it('kind=string 跳过', () => {
    const items = makeItemList([
      { kind: 'string', isDir: false, name: 'plain' },
      { kind: 'file', isDir: false, name: 'real.md' },
    ]);
    const r = partitionDropItems(items);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.name).toBe('real.md');
  });
});

// ────────────────────────────────────────────────────────────
// performDrop
// ────────────────────────────────────────────────────────────

const makeFs = (
  writeBinary: DropFsApi['writeBinary'] = vi.fn(async () => ok()),
): DropFsApi => ({ writeBinary });

const makeFile = (name: string, bytes: number[] = [1, 2, 3]): File =>
  new File([new Uint8Array(bytes)], name);

describe('performDrop', () => {
  it('空数组 → ok:true, written 空,不调 writeBinary', async () => {
    const fs = makeFs();
    const r = await performDrop([], '/work', fs);
    expect(r.ok).toBe(true);
    expect(r.written).toEqual([]);
    expect(fs.writeBinary).not.toHaveBeenCalled();
  });

  it('单文件成功 → 调 writeBinary(target/name, Uint8Array)', async () => {
    const writeBinary = vi.fn<DropFsApi['writeBinary']>(async () => ok());
    const fs = makeFs(writeBinary);
    const r = await performDrop([makeFile('a.md', [9, 8, 7])], '/work', fs);
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(['/work/a.md']);
    expect(writeBinary).toHaveBeenCalledTimes(1);
    expect(writeBinary).toHaveBeenCalledWith(
      '/work/a.md',
      expect.any(Uint8Array),
    );
    const call = writeBinary.mock.calls[0]!;
    expect(Array.from(call[1])).toEqual([9, 8, 7]);
  });

  it('多文件全成功 → written 全列出', async () => {
    const fs = makeFs();
    const r = await performDrop(
      [makeFile('a.md'), makeFile('b.png'), makeFile('c.txt')],
      '/work/sub',
      fs,
    );
    expect(r.ok).toBe(true);
    expect(r.written).toEqual([
      '/work/sub/a.md',
      '/work/sub/b.png',
      '/work/sub/c.txt',
    ]);
  });

  it('部分写失败 → ok:false + failed 列出', async () => {
    const writeBinary = vi
      .fn<DropFsApi['writeBinary']>()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail('FS_DENIED', 'no perm'))
      .mockResolvedValueOnce(ok());
    const fs = makeFs(writeBinary);
    const r = await performDrop(
      [makeFile('a'), makeFile('b'), makeFile('c')],
      '/work',
      fs,
    );
    expect(r.ok).toBe(false);
    expect(r.written).toEqual(['/work/a', '/work/c']);
    expect(r.failed).toEqual([
      { name: 'b', code: 'FS_DENIED', message: 'no perm' },
    ]);
  });

  it('file.arrayBuffer 抛 → failed READ_ERROR', async () => {
    const fs = makeFs();
    const badFile = {
      name: 'bad',
      arrayBuffer: () => Promise.reject(new Error('disk eject')),
    } as unknown as File;
    const r = await performDrop([badFile], '/work', fs);
    expect(r.ok).toBe(false);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ name: 'bad', code: 'READ_ERROR' });
    expect(fs.writeBinary).not.toHaveBeenCalled();
  });

  it('同名不主动跳过(交给 atomic write 覆盖)', async () => {
    const writeBinary = vi.fn(async () => ok());
    const fs = makeFs(writeBinary);
    const r = await performDrop(
      [makeFile('dup'), makeFile('dup')],
      '/work',
      fs,
    );
    expect(r.ok).toBe(true);
    expect(writeBinary).toHaveBeenCalledTimes(2);
    expect(r.written).toEqual(['/work/dup', '/work/dup']);
  });
});
