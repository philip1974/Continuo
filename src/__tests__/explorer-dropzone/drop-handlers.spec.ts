import { describe, it, expect, vi } from 'vitest';
import {
  partitionDropItems,
  performDrop,
  resolveDropTarget,
  MAX_DROP_FILE_COUNT,
  type DropFsApi,
  type DropTargetEntry,
} from '../../panels/Explorer/drop-handlers';
import type { IpcResult } from '../../lib/fs/types';
import { flushMacrotasks } from '../_helpers/async';

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

  it('收集 files/skippedDirs 时预分配结果数组,不通过 push 扩容', () => {
    const items = makeItemList([
      { kind: 'file', isDir: false, name: 'x.txt' },
      { kind: 'file', isDir: true, name: 'mydir' },
      { kind: 'string', isDir: false, name: 'plain' },
      { kind: 'file', isDir: false, name: 'y.txt' },
    ]);

    const r = partitionDropItems(items);

    expect(r.files.map((f) => f.name)).toEqual(['x.txt', 'y.txt']);
    expect(r.skippedDirs).toEqual(['mydir']);
    expect(partitionDropItems.toString()).not.toContain('.push(');
  });

  it('空输入和无可收集项复用稳定空数组', () => {
    const empty = partitionDropItems(null);
    const onlyString = partitionDropItems(
      makeItemList([{ kind: 'string', isDir: false, name: 'plain' }]),
    );

    expect(onlyString.files).toBe(empty.files);
    expect(onlyString.skippedDirs).toBe(empty.skippedDirs);
  });

  // 边界(E115):partition 阶段即限数量,防超大 DataTransferItemList 在读文件前大量
  // getAsFile 物化(cap 此前只在 performDrop 太晚)。多收 1 个让 performDrop 仍能反馈 too-many。
  it('E115 超过 MAX_DROP_FILE_COUNT 的文件项在 partition 阶段截断', () => {
    let getAsFileCalls = 0;
    // 直接造一个会计数 getAsFile 的 item 列表(5000 个文件项)
    const N = 5000;
    const arr = Array.from({ length: N }, (_, i) => ({
      kind: 'file' as const,
      type: '',
      getAsFile: (): File | null => {
        getAsFileCalls++;
        return new File([new Uint8Array([1])], `f${i}.txt`);
      },
      getAsString: () => {},
      webkitGetAsEntry: () => ({ isDirectory: false, name: `f${i}.txt` }),
    }));
    const list = arr as unknown as DataTransferItemList;
    Object.defineProperty(list, 'length', { value: arr.length });

    const r = partitionDropItems(list);
    // 最多收 MAX_DROP_FILE_COUNT+1(多 1 个让 performDrop 反馈 too-many),远小于 N
    expect(r.files.length).toBe(MAX_DROP_FILE_COUNT + 1);
    expect(getAsFileCalls).toBe(MAX_DROP_FILE_COUNT + 1);
    expect(r.files.length).toBeLessThan(N);
  });

  it('E115 超大目录项列表受总扫描上限约束(skippedDirs/webkitGetAsEntry 不跑满)', () => {
    let entryCalls = 0;
    const N = 100000;
    // 全是目录项(kind=file + isDirectory)→ 每个调 webkitGetAsEntry 进 skippedDirs;
    // 验证总扫描上限阻止全量遍历(否则 entryCalls / skippedDirs 会达 N)。
    const arr = Array.from({ length: N }, (_, i) => ({
      kind: 'file' as const,
      type: '',
      getAsFile: (): File | null => null,
      getAsString: () => {},
      webkitGetAsEntry: () => {
        entryCalls++;
        return { isDirectory: true, name: `d${i}` };
      },
    }));
    const list = arr as unknown as DataTransferItemList;
    Object.defineProperty(list, 'length', { value: arr.length });

    const r = partitionDropItems(list);
    expect(r.files).toHaveLength(0);
    // 受 MAX_DROP_SCAN_ITEMS 约束:远小于 N(不全量遍历)。
    expect(entryCalls).toBeLessThan(N);
    expect(r.skippedDirs.length).toBeLessThan(N);
    expect(r.skippedDirs.length).toBeLessThanOrEqual(entryCalls);
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
  it('written/failed 结果按 files.length 预分配,不通过 push 扩容', async () => {
    const writeBinary = vi
      .fn<DropFsApi['writeBinary']>()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail('FS_DENIED', 'no perm'));
    const fs = makeFs(writeBinary);

    const r = await performDrop([makeFile('a.md'), makeFile('b.md')], '/work', fs);

    expect(r.written).toEqual(['/work/a.md']);
    expect(r.failed).toEqual([
      { name: 'b.md', code: 'FS_DENIED', message: 'no perm' },
    ]);
    const source = performDrop.toString();
    expect(source).not.toContain('written.push(');
    expect(source).not.toContain('failed.push(');
  });

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

  // 边界(E268):外部 File.name 不可信 —— 含 / \ .. / 控制字符 / 超长 → 路径穿越或超长路径放大。
  // 读 arrayBuffer / 拼 targetPath 前校验 leaf;非法归 failed(FS_BAD_NAME)且不调 writeBinary。
  it('E268 file.name 含路径分隔符 → FS_BAD_NAME,不写(防穿越到子路径)', async () => {
    const writeBinary = vi.fn<DropFsApi['writeBinary']>(async () => ok());
    const fs = makeFs(writeBinary);
    const r = await performDrop([makeFile('sub/evil.txt')], '/work', fs);
    expect(r.ok).toBe(false);
    expect(r.written).toEqual([]);
    expect(writeBinary).not.toHaveBeenCalled();
    expect(r.failed[0]!.code).toBe('FS_BAD_NAME');
  });

  it('E268 file.name 为 .. → FS_BAD_NAME,不写(防穿越到父路径)', async () => {
    const writeBinary = vi.fn<DropFsApi['writeBinary']>(async () => ok());
    const fs = makeFs(writeBinary);
    const r = await performDrop([makeFile('..')], '/work', fs);
    expect(r.failed[0]!.code).toBe('FS_BAD_NAME');
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('E268 file.name 含反斜杠 / 控制字符 → FS_BAD_NAME', async () => {
    const fs = makeFs();
    const r1 = await performDrop([makeFile('a\\b.txt')], '/work', fs);
    expect(r1.failed[0]!.code).toBe('FS_BAD_NAME');
    const r2 = await performDrop([makeFile('a\nb.txt')], '/work', fs);
    expect(r2.failed[0]!.code).toBe('FS_BAD_NAME');
  });

  it('E268 超长 file.name → FS_BAD_NAME 且 failed.name 截断(不放大)', async () => {
    const fs = makeFs();
    const longName = 'x'.repeat(5000) + '.txt';
    const r = await performDrop([makeFile(longName)], '/work', fs);
    expect(r.failed[0]!.code).toBe('FS_BAD_NAME');
    expect(r.failed[0]!.name.length).toBeLessThanOrEqual(255);
  });

  it('E268 合法 file.name 仍正常写(回归)', async () => {
    const writeBinary = vi.fn<DropFsApi['writeBinary']>(async () => ok());
    const fs = makeFs(writeBinary);
    const r = await performDrop([makeFile('normal.txt')], '/work', fs);
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(['/work/normal.txt']);
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

  // a11y(A137):writeBinary reject(IPC 抛错而非返回 {ok:false})须归类到 failed,
  // 不能让 performDrop 整体 reject(否则调用点漏报且 unhandled rejection)。
  it('writeBinary reject → failed WRITE_ERROR(不 reject)', async () => {
    const writeBinary = vi
      .fn<DropFsApi['writeBinary']>()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValueOnce(ok());
    const fs = makeFs(writeBinary);
    const r = await performDrop(
      [makeFile('a'), makeFile('b'), makeFile('c')],
      '/work',
      fs,
    );
    expect(r.ok).toBe(false);
    expect(r.written).toEqual(['/work/a', '/work/c']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ name: 'b', code: 'WRITE_ERROR' });
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

  // 边界(E41,E13 读侧对偶):performDrop 读前用 file.size 预检 —— 超大/海量拖放在
  // arrayBuffer() 把整个文件读进 renderer 内存之前就拒绝,挡 renderer OOM(主进程写入上限
  // 只在 IPC 后生效,挡不住 renderer 先 OOM)。
  describe('E41 · 拖放大小/数量预检', () => {
    // size getter only,arrayBuffer 应当不被调(读前拒绝)。
    const fakeFile = (name: string, size: number): File => {
      const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
      return { name, size, arrayBuffer } as unknown as File;
    };

    it('单文件超 64MiB → failed FS_FILE_TOO_LARGE,不调 arrayBuffer/writeBinary', async () => {
      const writeBinary = vi.fn<DropFsApi['writeBinary']>(async () => ok());
      const fs = makeFs(writeBinary);
      const huge = fakeFile('huge.bin', 64 * 1024 * 1024 + 1);
      const r = await performDrop([huge], '/work', fs);
      expect(r.ok).toBe(false);
      expect(r.failed[0]).toMatchObject({
        name: 'huge.bin',
        code: 'FS_FILE_TOO_LARGE',
      });
      expect(huge.arrayBuffer).not.toHaveBeenCalled(); // 读前拒绝,不进内存
      expect(writeBinary).not.toHaveBeenCalled();
    });

    it('累计总字节超 512MiB → 超出项 failed DROP_TOTAL_TOO_LARGE', async () => {
      const writeBinary = vi.fn<DropFsApi['writeBinary']>(async () => ok());
      const fs = makeFs(writeBinary);
      // 9 个 60MiB 文件(各 ≤64MiB 单文件上限);累计 540MiB,第 9 个跨过 512MiB。
      const files = Array.from({ length: 9 }, (_, i) =>
        fakeFile(`f${i}.bin`, 60 * 1024 * 1024),
      );
      const r = await performDrop(files, '/work', fs);
      expect(r.ok).toBe(false);
      // 前 8 个被接受(480MiB ≤ 512),第 9 个超 → DROP_TOTAL_TOO_LARGE。
      expect(writeBinary).toHaveBeenCalledTimes(8);
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]).toMatchObject({ code: 'DROP_TOTAL_TOO_LARGE' });
    });

    it('文件数超 1000 → 超出项 failed DROP_TOO_MANY_FILES', async () => {
      const writeBinary = vi.fn<DropFsApi['writeBinary']>(async () => ok());
      const fs = makeFs(writeBinary);
      const files = Array.from({ length: 1001 }, (_, i) =>
        fakeFile(`f${i}`, 1),
      );
      const r = await performDrop(files, '/work', fs);
      expect(r.ok).toBe(false);
      expect(writeBinary).toHaveBeenCalledTimes(1000); // 前 1000 接受
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]).toMatchObject({ code: 'DROP_TOO_MANY_FILES' });
    });

    it('上限内正常文件不受影响(行为保持)', async () => {
      const fs = makeFs();
      const r = await performDrop([makeFile('a.md', [1, 2, 3])], '/work', fs);
      expect(r.ok).toBe(true);
      expect(r.written).toEqual(['/work/a.md']);
    });
  });
});

// perf:外部拖入多文件改为有界并发读写(此前完全串行,1000 个小文件 = 1000 次串行
// arrayBuffer + IPC + fsync)。并发同时须:在途 arrayBuffer/写入有上界;同目标路径(大小写/NFC 折叠后)
// 严格按输入顺序串行(后项覆盖前项);written/failed 按输入顺序汇总。
describe('performDrop · 有界并发', () => {
  // 可手动放行的 writeBinary:记录在途峰值与调用顺序。
  function gatedFs() {
    let inFlight = 0;
    let peak = 0;
    const calls: { path: string; bytes: number[] }[] = [];
    const pending: { path: string; resolve: (r: IpcResult<void>) => void }[] = [];
    const writeBinary = vi.fn<DropFsApi['writeBinary']>(
      (path, content) =>
        new Promise<IpcResult<void>>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          calls.push({ path, bytes: Array.from(content) });
          pending.push({
            path,
            resolve: (r) => {
              inFlight -= 1;
              resolve(r);
            },
          });
        }),
    );
    return { fs: makeFs(writeBinary), calls, pending, peak: () => peak };
  }

  // 记录 arrayBuffer 在途峰值(读到写完之间都算在途内存)。
  function countingFiles(names: string[]) {
    let reading = 0;
    let peak = 0;
    const files = names.map(
      (name, i) =>
        ({
          name,
          size: 1,
          arrayBuffer: async () => {
            reading += 1;
            peak = Math.max(peak, reading);
            await flushMacrotasks(1);
            reading -= 1;
            return new Uint8Array([i]).buffer;
          },
        }) as unknown as File,
    );
    return { files, peak: () => peak };
  }

  it('不同目标并发写入,在途写入与 arrayBuffer 都有上界(2..8)', async () => {
    const g = gatedFs();
    const names = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const { files, peak: readPeak } = countingFiles(names);
    const done = performDrop(files, '/work', g.fs);
    // 每 tick 放行一个在途写入,直到全部完成
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    for (let n = 0; n < 500 && !settled; n++) {
      await flushMacrotasks(1);
      g.pending.shift()?.resolve(ok());
    }
    const r = await done;
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(names.map((n) => `/work/${n}`));
    expect(g.peak()).toBeGreaterThan(1);
    expect(g.peak()).toBeLessThanOrEqual(8);
    expect(readPeak()).toBeLessThanOrEqual(8);
  });

  it('同目标路径(含大小写差异)按输入顺序串行:前项写完才开始后项', async () => {
    const g = gatedFs();
    const { files } = countingFiles(['dup', 'other', 'DUP', 'dup']);
    const done = performDrop(files, '/work', g.fs);
    for (let n = 0; n < 10; n++) await flushMacrotasks(1);
    // 第一个 dup 未完成前,后续同名(DUP / dup)不得发起写入
    expect(g.calls.map((c) => c.path)).toEqual(['/work/dup', '/work/other']);
    // 放行第一个 dup
    g.pending.find((p) => p.path === '/work/dup')!.resolve(ok());
    g.pending.splice(g.pending.findIndex((p) => p.path === '/work/dup'), 1);
    for (let n = 0; n < 10; n++) await flushMacrotasks(1);
    expect(g.calls.map((c) => c.path)).toEqual(['/work/dup', '/work/other', '/work/DUP']);
    while (g.calls.length < 4 || g.pending.length > 0) {
      g.pending.shift()?.resolve(ok());
      await flushMacrotasks(1);
    }
    const r = await done;
    // 同名写入顺序 = 输入顺序(字节为输入下标):后项覆盖前项
    expect(g.calls.filter((c) => c.path !== '/work/other').map((c) => c.bytes[0])).toEqual([0, 2, 3]);
    expect(r.written).toEqual(['/work/dup', '/work/other', '/work/DUP', '/work/dup']);
  });

  it('前 4+ 项同目标键时,后续异键项仍并发启动(同键链不占满 worker)', async () => {
    const g = gatedFs();
    const { files } = countingFiles(['dup', 'DUP', 'dup', 'Dup', 'dup', 'x', 'y', 'z']);
    const done = performDrop(files, '/work', g.fs);
    for (let n = 0; n < 10; n++) await flushMacrotasks(1);
    // 第一个 dup 在途未放行:同键其余项等待,但 x/y/z 应已发起写入(同键组只占 1 个 worker)
    expect(g.calls.map((c) => c.path)).toEqual(['/work/dup', '/work/x', '/work/y', '/work/z']);
    while (g.calls.length < 8 || g.pending.length > 0) {
      g.pending.shift()?.resolve(ok());
      await flushMacrotasks(1);
    }
    const r = await done;
    // 同键组内仍按输入顺序串行
    expect(
      g.calls.filter((c) => c.path.toLowerCase() === '/work/dup').map((c) => c.bytes[0]),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(r.written).toEqual([
      '/work/dup',
      '/work/DUP',
      '/work/dup',
      '/work/Dup',
      '/work/dup',
      '/work/x',
      '/work/y',
      '/work/z',
    ]);
  });

  it('完成顺序乱序时 written/failed 仍按输入顺序汇总', async () => {
    const g = gatedFs();
    const { files } = countingFiles(['a', 'b', 'c', 'd']);
    const done = performDrop(files, '/work', g.fs);
    for (let n = 0; n < 10; n++) await flushMacrotasks(1);
    // 倒序完成:d ok, c fail, b fail, a ok
    const by = (p: string) => g.pending.find((x) => x.path === p)!;
    by('/work/d').resolve(ok());
    by('/work/c').resolve(fail('E_C'));
    by('/work/b').resolve(fail('E_B'));
    by('/work/a').resolve(ok());
    const r = await done;
    expect(r.written).toEqual(['/work/a', '/work/d']);
    expect(r.failed.map((f) => f.name)).toEqual(['b', 'c']);
  });
});
