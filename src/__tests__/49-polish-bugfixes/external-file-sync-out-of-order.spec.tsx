// @vitest-environment jsdom
// topic 49 · P2-BG(原 seqByPath latest-wins)→ 性能 P15(in-flight 合并取代之)。
//
// 旧根因:同一 path 短时间多次 fs:dir-changed → 多个并发、未序列化的 readFile,乱序
// resolve 时旧内容覆盖新内容。旧修复:每 path 单调 seq 丢弃过期结果。
//
// P15 改为 in-flight 合并:某 path 的 read 在途时,新事件只标记 pending,不再并发发起;
// 在途 read 完成后若 pending 则尾随重读一次(读最终内容),跳过被取代的中间结果。每
// path 读严格串行 → 并发乱序回写的场景**根本不会发生**(比 seqByPath 更强)。本测试
// 验证:burst 被合并 + 最终落地最新内容 + 陈旧中间结果不落地 + dirty 保护。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const fsMock = vi.hoisted(() => ({
  onDirChanged: vi.fn(),
  readFile: vi.fn(),
}));
const storeMock = vi.hoisted(() => ({
  tabs: [] as Array<{ id: string; filePath: string | null; dirty: boolean }>,
  reloadFromDisk: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({ coApi: { fs: fsMock } }));
vi.mock('@/stores/editor.store', () => ({
  useEditorStore: { getState: () => storeMock },
}));

import { useExternalFileSync } from '../../panels/Editor/useExternalFileSync';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.tabs = [{ id: '/dir/f.txt', filePath: '/dir/f.txt', dirty: false }];
});

describe('P15 · useExternalFileSync in-flight 合并', () => {
  it('在途期间的 burst 事件被合并,只尾随一次读,最终落地最新内容,中间结果不落地', async () => {
    let cb: (changedDir: string) => void = () => {};
    fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
      cb = fn;
      return () => {};
    });

    const d1 = deferred<{ ok: true; data: string }>(); // leading 读(中间/旧内容)
    const d2 = deferred<{ ok: true; data: string }>(); // 尾随读(最终/新内容)
    fsMock.readFile
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);

    renderHook(() => useExternalFileSync());

    // 首个事件 → 立即发起 read(leading);随后 burst 内 2 个事件在途期间 → 合并,不并发
    cb('/dir');
    cb('/dir');
    cb('/dir');
    expect(fsMock.readFile).toHaveBeenCalledTimes(1); // 合并:在途只有 1 个并发读

    // leading 读完成(读到中间/旧内容)→ 因有 pending 被取代,**不落地**,尾随重读
    d1.resolve({ ok: true, data: 'STALE-OLD' });
    await Promise.resolve();
    await Promise.resolve();
    expect(fsMock.readFile).toHaveBeenCalledTimes(2); // 尾随读发起
    expect(
      storeMock.reloadFromDisk.mock.calls.some((c) => c[1] === 'STALE-OLD'),
    ).toBe(false); // 中间结果不落地

    // 尾随读完成(最终内容)→ 落地
    d2.resolve({ ok: true, data: 'NEW' });
    await Promise.resolve();
    await Promise.resolve();
    const calls = storeMock.reloadFromDisk.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['/dir/f.txt', 'NEW']);
  });

  it('单个事件 → 立即读并落地(无 burst 时不延迟)', async () => {
    let cb: (changedDir: string) => void = () => {};
    fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
      cb = fn;
      return () => {};
    });
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'fresh' });
    renderHook(() => useExternalFileSync());
    cb('/dir');
    expect(fsMock.readFile).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(storeMock.reloadFromDisk).toHaveBeenCalledWith('/dir/f.txt', 'fresh');
  });

  it('dirty tab 不被外部同步覆盖(既有保护保持)', async () => {
    storeMock.tabs = [{ id: '/dir/f.txt', filePath: '/dir/f.txt', dirty: true }];
    let cb: (changedDir: string) => void = () => {};
    fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
      cb = fn;
      return () => {};
    });
    renderHook(() => useExternalFileSync());
    cb('/dir');
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});
