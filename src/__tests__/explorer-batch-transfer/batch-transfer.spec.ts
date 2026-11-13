// 重构守卫:Explorer 批量移动/复制收口到 transferEntriesInto(此前 onDropItems / root-drop / onPaste
// 三处内联副本;P2-BB 部分成功刷新、R7 剪贴板 prune、A134-A136 reject 反馈的行为化契约)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  transferEntriesInto,
  type BatchTransferDeps,
} from '../../panels/Explorer/batch-transfer';

type Result = { ok: true; data: undefined } | { ok: false; code: string; message: string };
const OK: Result = { ok: true, data: undefined };
const fail = (code: string): Result => ({ ok: false, code, message: `${code} msg` });

function makeDeps(over: {
  move?: (src: string, dest: string) => Promise<Result>;
  copy?: (src: string, dest: string) => Promise<Result>;
  picker?: BatchTransferDeps['makeUniqueDestPicker'];
} = {}) {
  const events: string[] = [];
  const deps = {
    fs: {
      move: vi.fn(over.move ?? (async () => OK)),
      copy: vi.fn(over.copy ?? (async () => OK)),
    },
    makeUniqueDestPicker: vi.fn(
      over.picker ?? (async (destDir: string) => (name: string) => `${destDir}/${name}`),
    ),
    refreshDir: vi.fn((dir: string) => void events.push(`refresh:${dir}`)),
    onMoved: vi.fn((src: string, dest: string) => void events.push(`moved:${src}->${dest}`)),
    onSourcesGone: vi.fn((srcs: string[]) => void events.push(`gone:${srcs.join(',')}`)),
    onItemFailed: vi.fn((src: string, code: string) => void events.push(`failed:${src}:${code}`)),
    onException: vi.fn(() => void events.push('exception')),
  };
  return { deps: deps as unknown as BatchTransferDeps, spies: deps, events };
}

describe('transferEntriesInto — move', () => {
  it('全部成功:逐项 move + onMoved,刷新目标与源父目录,回报已移走的源', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('move', ['/a/x.txt', '/b/y.txt'], '/dest', deps);

    expect(spies.makeUniqueDestPicker).toHaveBeenCalledTimes(1);
    expect(spies.fs.move.mock.calls).toEqual([
      ['/a/x.txt', '/dest/x.txt'],
      ['/b/y.txt', '/dest/y.txt'],
    ]);
    expect(spies.onMoved.mock.calls).toEqual([
      ['/a/x.txt', '/dest/x.txt'],
      ['/b/y.txt', '/dest/y.txt'],
    ]);
    expect(spies.refreshDir.mock.calls.map((c) => c[0]).sort()).toEqual(['/a', '/b', '/dest']);
    expect(spies.onSourcesGone).toHaveBeenCalledWith(['/a/x.txt', '/b/y.txt']);
    expect(spies.onItemFailed).not.toHaveBeenCalled();
    expect(spies.onException).not.toHaveBeenCalled();
  });

  it('中途失败:中止其余项,但已成功项仍刷新 + 回报(P2-BB / R7)', async () => {
    const { deps, spies } = makeDeps({
      move: async (src) => (src === '/b/y.txt' ? fail('EACCES') : OK),
    });
    await transferEntriesInto('move', ['/a/x.txt', '/b/y.txt', '/c/z.txt'], '/dest', deps);

    expect(spies.fs.move).toHaveBeenCalledTimes(2); // 第三项不再尝试
    expect(spies.onItemFailed).toHaveBeenCalledWith('/b/y.txt', 'EACCES', 'EACCES msg');
    expect(spies.refreshDir.mock.calls.map((c) => c[0]).sort()).toEqual(['/a', '/dest']);
    expect(spies.onSourcesGone).toHaveBeenCalledWith(['/a/x.txt']);
  });

  it('首项即失败:不刷新、不回报', async () => {
    const { deps, spies } = makeDeps({ move: async () => fail('EPERM') });
    await transferEntriesInto('move', ['/a/x.txt'], '/dest', deps);
    expect(spies.refreshDir).not.toHaveBeenCalled();
    expect(spies.onSourcesGone).not.toHaveBeenCalled();
  });

  it('move reject:onException,不抛;已成功项仍刷新 + 回报(A134/A136)', async () => {
    const { deps, spies } = makeDeps({
      move: async (src) => {
        if (src === '/b/y.txt') throw new Error('ipc down');
        return OK;
      },
    });
    await expect(
      transferEntriesInto('move', ['/a/x.txt', '/b/y.txt'], '/dest', deps),
    ).resolves.toBeUndefined();
    expect(spies.onException).toHaveBeenCalledTimes(1);
    expect(spies.refreshDir.mock.calls.map((c) => c[0]).sort()).toEqual(['/a', '/dest']);
    expect(spies.onSourcesGone).toHaveBeenCalledWith(['/a/x.txt']);
  });

  it('目标名探测 reject:onException,不调 fs', async () => {
    const { deps, spies } = makeDeps({
      picker: async () => {
        throw new Error('listDir failed');
      },
    });
    await transferEntriesInto('move', ['/a/x.txt'], '/dest', deps);
    expect(spies.onException).toHaveBeenCalledTimes(1);
    expect(spies.fs.move).not.toHaveBeenCalled();
    expect(spies.refreshDir).not.toHaveBeenCalled();
  });

  it('源父目录即目标目录:目标目录只刷新一次', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('move', ['/dest/x.txt'], '/dest', deps);
    expect(spies.refreshDir.mock.calls).toEqual([['/dest']]);
  });

  it('skipSameParent:已在目标目录的源跳过(拖到原父目录 no-op)', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('move', ['/dest/x.txt', '/a/y.txt'], '/dest', deps, {
      skipSameParent: true,
    });
    expect(spies.fs.move.mock.calls).toEqual([['/a/y.txt', '/dest/y.txt']]);
    expect(spies.onSourcesGone).toHaveBeenCalledWith(['/a/y.txt']);
  });
});

describe('transferEntriesInto — copy', () => {
  it('复制不动源:不调 onMoved / onSourcesGone,只刷新目标目录', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('copy', ['/a/x.txt', '/b/y.txt'], '/dest', deps);
    expect(spies.fs.copy).toHaveBeenCalledTimes(2);
    expect(spies.fs.move).not.toHaveBeenCalled();
    expect(spies.onMoved).not.toHaveBeenCalled();
    expect(spies.onSourcesGone).not.toHaveBeenCalled();
    expect(spies.refreshDir.mock.calls).toEqual([['/dest']]);
  });

  it('中途失败:已复制项仍刷新目标目录', async () => {
    const { deps, spies } = makeDeps({
      copy: async (src) => (src === '/b/y.txt' ? fail('ENOSPC') : OK),
    });
    await transferEntriesInto('copy', ['/a/x.txt', '/b/y.txt'], '/dest', deps);
    expect(spies.onItemFailed).toHaveBeenCalledWith('/b/y.txt', 'ENOSPC', 'ENOSPC msg');
    expect(spies.refreshDir.mock.calls).toEqual([['/dest']]);
  });
});

describe('接线守卫:FolderTree 的批量入口都走共享实现', () => {
  const SRC = readFileSync(
    join(__dirname, '..', '..', 'panels', 'Explorer', 'FolderTree.tsx'),
    'utf-8',
  );

  it('三个移动/复制入口(onDropItems / root-drop / onPaste)经 runBatchTransfer 调 transferEntriesInto', () => {
    // runBatchTransfer 是组件内唯一的 transferEntriesInto 包装(注入 store / notify 依赖)。
    expect((SRC.match(/void runBatchTransfer\(|await runBatchTransfer\(/g) ?? []).length).toBe(3);
    expect((SRC.match(/transferEntriesInto\(/g) ?? []).length).toBe(1);
  });

  it('两个外部文件 drop 入口(row / 空白)调 dropForeignFilesInto', () => {
    expect((SRC.match(/dropForeignFilesInto\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('组件内不再内联 fs.move / fs.copy / performDrop', () => {
    expect(SRC).not.toMatch(/coApi\.fs\.move\(/);
    expect(SRC).not.toMatch(/coApi\.fs\.copy\(/);
    expect(SRC).not.toMatch(/performDrop\(/);
  });
});
