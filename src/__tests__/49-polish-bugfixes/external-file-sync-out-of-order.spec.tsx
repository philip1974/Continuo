// @vitest-environment jsdom
// topic 49 · P2-BG:useExternalFileSync 并发 readFile 乱序回写竞态。
//
// 根因:同一 path 短时间内多次 fs:dir-changed → 对该 path 发起多个并发、未防抖、未
// 序列化的 readFile。Promise 可能乱序 resolve:较早发起、读到旧内容的回调若**后**
// resolve,会用陈旧内容覆盖较新内容调 reloadFromDisk → editor 显示回退到旧版本
// (外部 git checkout / 格式化工具快速连续重写已打开的 clean 文件时触发)。
//
// 修复:每 path 维护单调 seq,resolve 时丢弃非最新一轮的结果(latest-wins)。

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
  storeMock.tabs = [{ id: 't1', filePath: '/dir/f.txt', dirty: false }];
});

describe('topic49 P2-BG · useExternalFileSync 乱序读丢弃过期结果', () => {
  it('较早发起的旧读后 resolve 时不覆盖较新读的结果', async () => {
    let cb: (changedDir: string) => void = () => {};
    fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
      cb = fn;
      return () => {};
    });

    const d1 = deferred<{ ok: true; data: string }>();
    const d2 = deferred<{ ok: true; data: string }>();
    fsMock.readFile
      .mockReturnValueOnce(d1.promise) // 第一轮(旧)
      .mockReturnValueOnce(d2.promise); // 第二轮(新)

    renderHook(() => useExternalFileSync());

    // 两次 dir-changed → 两个并发 readFile
    cb('/dir');
    cb('/dir');
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);

    // 乱序:第二轮(新)先 resolve,第一轮(旧)后 resolve
    d2.resolve({ ok: true, data: 'NEW' });
    await Promise.resolve();
    d1.resolve({ ok: true, data: 'STALE-OLD' });
    await Promise.resolve();
    await Promise.resolve();

    // 最终落地必须是 NEW;旧读后 resolve 被 seq 守卫丢弃,不会覆盖
    const calls = storeMock.reloadFromDisk.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const last = calls[calls.length - 1];
    expect(last).toEqual(['t1', 'NEW']);
    // STALE-OLD 永不应落地
    expect(
      calls.some((c) => c[1] === 'STALE-OLD'),
    ).toBe(false);
  });

  it('dirty tab 不被外部同步覆盖(既有保护保持)', async () => {
    storeMock.tabs = [{ id: 't1', filePath: '/dir/f.txt', dirty: true }];
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
