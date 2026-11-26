// 重构守卫:Explorer 批量移动/复制收口到 transferEntriesInto(此前 onDropItems / root-drop / onPaste
// 三处内联副本;P2-BB 部分成功刷新、R7 剪贴板 prune、A134-A136 reject 反馈的行为化契约)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  transferEntriesInto,
  type BatchTransferDeps,
} from '../../panels/Explorer/batch-transfer';
import { isDestInsideSource } from '../../panels/Explorer/path-utils';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

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
    onItemFailed: vi.fn((src: string, code: string) => void events.push(`failed:${src}:${code}`)),
    onException: vi.fn(() => void events.push('exception')),
  };
  return { deps: deps as unknown as BatchTransferDeps, spies: deps, events };
}

describe('transferEntriesInto — move', () => {
  it('全部成功:逐项 move + onMoved,刷新目标与源父目录', async () => {
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
    expect(spies.onItemFailed).not.toHaveBeenCalled();
    expect(spies.onException).not.toHaveBeenCalled();
  });

  it('中途失败:中止其余项,但已成功项仍刷新 + onMoved(P2-BB / R7)', async () => {
    const { deps, spies } = makeDeps({
      move: async (src) => (src === '/b/y.txt' ? fail('EACCES') : OK),
    });
    await transferEntriesInto('move', ['/a/x.txt', '/b/y.txt', '/c/z.txt'], '/dest', deps);

    expect(spies.fs.move).toHaveBeenCalledTimes(2); // 第三项不再尝试
    expect(spies.onItemFailed).toHaveBeenCalledWith('/b/y.txt', 'EACCES', 'EACCES msg');
    // 失败项 /b/y.txt 的源父目录也刷新(可能已部分落盘),但不回报为已移走
    expect(spies.refreshDir.mock.calls.map((c) => c[0]).sort()).toEqual(['/a', '/b', '/dest']);
    expect(spies.onMoved.mock.calls).toEqual([['/a/x.txt', '/dest/x.txt']]);
  });

  it('首项即失败:不 onMoved;仍刷新目标与该项源父目录(失败可能已部分落盘)', async () => {
    const { deps, spies } = makeDeps({ move: async () => fail('EPERM') });
    await transferEntriesInto('move', ['/a/x.txt'], '/dest', deps);
    expect(spies.refreshDir.mock.calls.map((c) => c[0]).sort()).toEqual(['/a', '/dest']);
    expect(spies.onMoved).not.toHaveBeenCalled();
  });

  it('move reject:onException,不抛;已成功项仍刷新 + onMoved(A134/A136)', async () => {
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
    expect(spies.onMoved.mock.calls).toEqual([['/a/x.txt', '/dest/x.txt']]);
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

  it('已在目标目录的源跳过(拖到原父目录 / 剪切后粘贴回原目录都是 no-op)', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('move', ['/dest/x.txt', '/a/y.txt'], '/dest', deps);
    expect(spies.fs.move.mock.calls).toEqual([['/a/y.txt', '/dest/y.txt']]);
    expect(spies.onMoved.mock.calls).toEqual([['/a/y.txt', '/dest/y.txt']]);
  });
});

// 粘贴入口此前缺拖动入口已有的两道判定(拖动靠 canDrop + 调用方传 skipSameParent),现收进漏斗本身。
describe('transferEntriesInto — 目标与源的相对位置(粘贴 / 拖动共用)', () => {
  // 模拟 listDir 快照:existing[dir] 中已有的名字 → 加 ` copy`(真实 picker 见 makeNamePicker)。
  const pickerWith = (existing: Record<string, string[]>): BatchTransferDeps['makeUniqueDestPicker'] =>
    async (dir) => (name) =>
      (existing[dir] ?? []).includes(name) ? `${dir}/${name} copy` : `${dir}/${name}`;

  it('剪切 X/a.ts 后粘贴回 X:no-op,不改名成 `a copy.ts`、不提示错误、不刷新', async () => {
    const { deps, spies } = makeDeps({ picker: pickerWith({ '/X': ['a.ts'] }) });
    await transferEntriesInto('move', ['/X/a.ts'], '/X', deps);
    expect(spies.fs.move).not.toHaveBeenCalled();
    expect(spies.onMoved).not.toHaveBeenCalled();
    expect(spies.onItemFailed).not.toHaveBeenCalled();
    expect(spies.onException).not.toHaveBeenCalled();
    expect(spies.refreshDir).not.toHaveBeenCalled();
  });

  it('复制文件夹 A 后粘贴到 A 自身 → 在父目录生成 `A copy`(VSCode 同款)', async () => {
    const { deps, spies } = makeDeps({ picker: pickerWith({ '/r': ['A'] }) });
    await transferEntriesInto('copy', ['/r/A'], '/r/A', deps);
    expect(spies.fs.copy.mock.calls).toEqual([['/r/A', '/r/A copy']]);
    expect(spies.refreshDir.mock.calls.map((c) => c[0])).toContain('/r');
    expect(spies.onItemFailed).not.toHaveBeenCalled();
  });

  it('复制文件夹 A 后粘贴到其子目录 A/B → 明确错误(FS_MOVE_INTO_SELF,VSCode 同款),整批不触发 fs', async () => {
    const { deps, spies } = makeDeps({ picker: pickerWith({ '/r': ['A'] }) });
    await transferEntriesInto('copy', ['/r/A', '/s/y.txt'], '/r/A/B', deps);
    expect(spies.fs.copy).not.toHaveBeenCalled();
    expect(spies.onItemFailed.mock.calls[0]?.slice(0, 2)).toEqual(['/r/A', 'FS_MOVE_INTO_SELF']);
    expect(spies.refreshDir).not.toHaveBeenCalled();
  });

  it('剪切文件夹 A 后粘贴到 A/B → 明确错误(FS_MOVE_INTO_SELF),不触发 fs、不刷新', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('move', ['/r/A'], '/r/A/B', deps);
    expect(spies.fs.move).not.toHaveBeenCalled();
    expect(spies.onMoved).not.toHaveBeenCalled();
    expect(spies.onItemFailed).toHaveBeenCalledTimes(1);
    expect(spies.onItemFailed.mock.calls[0]?.slice(0, 2)).toEqual(['/r/A', 'FS_MOVE_INTO_SELF']);
    expect(spies.refreshDir).not.toHaveBeenCalled();
  });

  // 切换 root 后剪贴板仍持有旧 root 下的目录,恰等于新 root:其父目录在工作区外 → 不改投,按粘贴到自身报错(不在树外
  // 静默写出副本;VSCode 中 root 元素无 parent 同样失败)。
  it('复制的目录恰是当前工作区根,粘贴到根 → FS_MOVE_INTO_SELF,不写到工作区外', async () => {
    const { deps, spies } = makeDeps({ picker: pickerWith({ '/ws': ['A'] }) });
    await transferEntriesInto('copy', ['/ws/A'], '/ws/A', { ...deps, root: '/ws/A' });
    expect(spies.fs.copy).not.toHaveBeenCalled();
    expect(spies.onItemFailed.mock.calls[0]?.slice(0, 2)).toEqual(['/ws/A', 'FS_MOVE_INTO_SELF']);
  });

  it('剪切文件夹 A 后粘贴到 A 自身 → 目标改投父目录即原处,no-op(VSCode 同款),不报错、不改名', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('move', ['/r/A'], '/r/A', deps);
    expect(spies.fs.move).not.toHaveBeenCalled();
    expect(spies.onItemFailed).not.toHaveBeenCalled();
    expect(spies.onMoved).not.toHaveBeenCalled();
  });

  it('FS_MOVE_INTO_SELF 有三语本地化文案', () => {
    for (const dict of [en, zh, ko] as Record<string, string>[]) {
      expect(dict['errors.FS_MOVE_INTO_SELF']).toBeTruthy();
    }
  });

  it('拖动 canDrop 与漏斗共用同一判定 helper(isDestInsideSource)', () => {
    const read = (f: string) =>
      readFileSync(join(__dirname, '..', '..', 'panels', 'Explorer', f), 'utf-8');
    expect(read('tree-config.ts')).toMatch(/isDestInsideSource\(srcId, destDir\)/);
    expect(read('batch-transfer.ts')).toMatch(/isDestInsideSource\(src, dir\)/);
    expect(isDestInsideSource('/r/A', '/r/A')).toBe(true);
    expect(isDestInsideSource('/r/A', '/r/A/B')).toBe(true);
    expect(isDestInsideSource('/r/A', '/r/AB')).toBe(false);
    expect(isDestInsideSource('/r/A/B', '/r/A')).toBe(false);
  });
});

describe('transferEntriesInto — copy', () => {
  it('复制不动源:不调 onMoved,只刷新目标目录', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('copy', ['/a/x.txt', '/b/y.txt'], '/dest', deps);
    expect(spies.fs.copy).toHaveBeenCalledTimes(2);
    expect(spies.fs.move).not.toHaveBeenCalled();
    expect(spies.onMoved).not.toHaveBeenCalled();
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
    // runBatchTransfer 是组件内唯一的 transferEntriesInto 包装(注入 store / notify 依赖)。两个拖动入口先经
    // requestDragMove(拖放确认,explorer-confirm-drag-and-drop/),它直接调或确认后调 runBatchTransfer;onPaste 直接调。
    expect((SRC.match(/requestDragMove\(selectDraggedItemPaths\(/g) ?? []).length).toBe(2);
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
