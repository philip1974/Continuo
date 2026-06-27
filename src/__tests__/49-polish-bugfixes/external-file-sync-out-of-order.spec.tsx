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

  it('tab identity 复查走单趟 helper,不调用 tabs.find', async () => {
    let cb: (changedDir: string) => void = () => {};
    fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
      cb = fn;
      return () => {};
    });
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'fresh' });
    const findSpy = vi.spyOn(storeMock.tabs, 'find');

    try {
      renderHook(() => useExternalFileSync());
      cb('/dir');
      await Promise.resolve();
      await Promise.resolve();

      expect(storeMock.reloadFromDisk).toHaveBeenCalledWith(
        '/dir/f.txt',
        'fresh',
      );
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  // 数据安全(codex 复查 P2):readFile 的 promise reject(桥/进程/通道异常,非 handler
  // 的 {ok:false})时,旧实现只有 .then 无 .catch/.finally → inFlight 永不清,该 path
  // 后续 dir-changed 只 pending.add 不再重读 → clean tab 长期停旧内容,用户基于旧内容
  // 编辑保存覆盖外部新内容。加 catch/finally 后:reject 不落地、清 inFlight、后续事件能重读。
  it('readFile reject → 不落地 + inFlight 清,后续事件能重读恢复(不卡死陈旧内容)', async () => {
    let cb: (changedDir: string) => void = () => {};
    fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
      cb = fn;
      return () => {};
    });

    let rejectFirst!: (e: unknown) => void;
    const p1 = new Promise<{ ok: true; data: string }>((_, rej) => {
      rejectFirst = rej;
    });
    fsMock.readFile
      .mockReturnValueOnce(p1)
      .mockResolvedValue({ ok: true, data: 'RECOVERED' });

    renderHook(() => useExternalFileSync());

    cb('/dir'); // 第一次读(将 reject)
    expect(fsMock.readFile).toHaveBeenCalledTimes(1);

    rejectFirst(new Error('bridge crash')); // 桥/进程异常 → promise reject
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // 本次不落地
    expect(storeMock.reloadFromDisk).not.toHaveBeenCalled();

    // inFlight 已清 → 后续 dir-changed 能再次发起 read(不再只 pending.add)
    cb('/dir');
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(storeMock.reloadFromDisk).toHaveBeenCalledWith(
      '/dir/f.txt',
      'RECOVERED',
    );
  });

  // race(R79):effect cleanup 只 unsub 不失效在途 readFile → 卸载/重挂(StrictMode 双 effect)
  // 后旧 effect 的慢读仍会 reloadFromDisk(tabId, 旧快照),回滚 clean tab。cancelled 令牌:
  // cleanup 后迟到的 settle 直接丢弃。
  it('R79 effect unmount 后在途 read 的迟到结果不落地(不回滚 clean tab)', async () => {
    let cb: (changedDir: string) => void = () => {};
    const unsub = vi.fn();
    fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
      cb = fn;
      return unsub;
    });
    const d1 = deferred<{ ok: true; data: string }>();
    fsMock.readFile.mockReturnValueOnce(d1.promise);

    const { unmount } = renderHook(() => useExternalFileSync());
    cb('/dir'); // 发起在途 read
    expect(fsMock.readFile).toHaveBeenCalledTimes(1);

    // effect cleanup(卸载):应失效在途 read。
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);

    // 在途 read 此刻才 resolve(迟到)→ 过期 effect 结果,绝不落地。
    d1.resolve({ ok: true, data: 'STALE-AFTER-UNMOUNT' });
    await Promise.resolve();
    await Promise.resolve();
    expect(storeMock.reloadFromDisk).not.toHaveBeenCalled();
  });

  // race(R97):读在途期间 tab 被 close+reopen(同路径 → 同 id 但新 tab 实例),旧读迟到回写会覆盖
  // 新 tab(可能已是更新内容)。捕获 tabRef + settle 前比对实例 identity,不匹配则丢弃。
  it('R97 读在途时 tab 被 close+reopen(同 id 新实例)→ 迟到读不覆盖新 tab', async () => {
    let cb: (changedDir: string) => void = () => {};
    fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
      cb = fn;
      return () => {};
    });
    const d = deferred<{ ok: true; data: string }>();
    fsMock.readFile.mockReturnValueOnce(d.promise);
    const tabA = { id: '/dir/f.txt', filePath: '/dir/f.txt', dirty: false };
    storeMock.tabs = [tabA];

    renderHook(() => useExternalFileSync());
    cb('/dir'); // readAndApply 捕获 tabRef = tabA(读在途)
    expect(fsMock.readFile).toHaveBeenCalledTimes(1);

    // 模拟 close+reopen 同路径:同 id 的全新 tab 对象(clean)。
    storeMock.tabs = [{ id: '/dir/f.txt', filePath: '/dir/f.txt', dirty: false }];

    // 旧读此刻才 resolve(迟到):live tab(新实例)!== 捕获的 tabRef(tabA)→ 丢弃,不覆盖新 tab。
    d.resolve({ ok: true, data: 'STALE-FROM-CLOSED-TAB' });
    await Promise.resolve();
    await Promise.resolve();
    expect(storeMock.reloadFromDisk).not.toHaveBeenCalled();
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

  // 跨平台(codex 复查 P1):dir 匹配走共享 dirname(盘根正确)+ 平台感知 pathEquals。
  // Windows 上 watcher 广播目录与 tab 父目录仅大小写不同、或文件位于盘根时,clean tab 须
  // 仍收到外部 reload(否则旧内容覆盖磁盘新内容)。
  it('Windows 大小写不同目录 → clean tab 仍匹配并重读', async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      storeMock.tabs = [
        { id: 'C:\\Dir\\f.txt', filePath: 'C:\\Dir\\f.txt', dirty: false },
      ];
      let cb: (changedDir: string) => void = () => {};
      fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
        cb = fn;
        return () => {};
      });
      fsMock.readFile.mockResolvedValue({ ok: true, data: 'fresh' });
      renderHook(() => useExternalFileSync());
      cb('c:\\dir'); // watcher 广播大小写不同的目录
      expect(fsMock.readFile).toHaveBeenCalledWith('C:\\Dir\\f.txt');
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });

  it('Windows 盘根文件 → dir 匹配盘根并重读(不再因 dirname 返 C: 漏匹配)', async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      storeMock.tabs = [
        { id: 'C:\\a.txt', filePath: 'C:\\a.txt', dirty: false },
      ];
      let cb: (changedDir: string) => void = () => {};
      fsMock.onDirChanged.mockImplementation((fn: (d: string) => void) => {
        cb = fn;
        return () => {};
      });
      fsMock.readFile.mockResolvedValue({ ok: true, data: 'fresh' });
      renderHook(() => useExternalFileSync());
      cb('C:\\'); // 盘根
      expect(fsMock.readFile).toHaveBeenCalledWith('C:\\a.txt');
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });
});
