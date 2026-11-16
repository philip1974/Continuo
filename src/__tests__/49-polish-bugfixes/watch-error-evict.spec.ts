// 健壮性(独立审计):fs.ipc 的生产 watcher creator 只保存 `close()`,未监听 FSWatcher 的异步
// 'error' 事件。网络盘 / 可移动卷断开、被 watch 目录失效时 FSWatcher emit('error'),EventEmitter
// 无 error 监听即抛出 → 主进程未捕获异常崩溃。修复:creator 注册 error 监听(console.warn),
// 并回调池把失效 watcher 关闭、移出池与 owner 记账(复用 LRU 驱逐同款清理),不崩溃。

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatcherPool, type WatcherCreator } from '../../../electron/main/ipc/fs/watch';

const mocks = vi.hoisted(() => ({
  watchers: [] as Array<EventEmitter & { close: () => void }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {},
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = vi.fn(() => {
    const w = Object.assign(new EventEmitter(), { close: vi.fn() });
    mocks.watchers.push(w);
    return w;
  });
  return { ...actual, default: { ...actual, watch }, watch };
});

afterEach(() => {
  mocks.watchers = [];
  vi.restoreAllMocks();
});

describe('WatcherPool:creator 上报 watcher 失效 → 关闭并移出池', () => {
  it('onError 回调后 has(path)=false、close 被调用;后续 unwatch 不抛', () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    let report: ((err: unknown) => void) | undefined;
    const creator: WatcherCreator = (_p, _onChange, onError) => {
      report = onError;
      const close = vi.fn();
      closes.push(close);
      return { close };
    };
    const pool = createWatcherPool(creator);
    pool.watch('/vol/dir', vi.fn(), 1);
    expect(pool.has('/vol/dir')).toBe(true);

    report!(new Error('EIO'));

    expect(pool.has('/vol/dir')).toBe(false);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(() => pool.unwatch('/vol/dir', 1)).not.toThrow();
    expect(() => pool.unwatchByOwner(1)).not.toThrow();
  });

  it('迟到的 onError 不误杀同 path 重建的新 watcher', () => {
    const reports: Array<(err: unknown) => void> = [];
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const pool = createWatcherPool((_p, _onChange, onError) => {
      reports.push(onError);
      const close = vi.fn();
      closes.push(close);
      return { close };
    });
    pool.watch('/d', vi.fn());
    pool.unwatch('/d'); // 旧 watcher 正常释放
    pool.watch('/d', vi.fn()); // 同 path 重建

    reports[0]!(new Error('late'));

    expect(pool.has('/d')).toBe(true);
    expect(closes[1]).not.toHaveBeenCalled();
  });
});

describe('fs.ipc 生产 creator:FSWatcher emit error 不崩溃主进程', () => {
  it('emit("error") 不抛 + console.warn + 上报池', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createFsWatcher } = await import('../../../electron/main/ipc/fs.ipc');
    const onError = vi.fn();
    createFsWatcher('/vol/dir', vi.fn(), onError);
    const w = mocks.watchers.at(-1)!;

    // 无 error 监听时 EventEmitter.emit('error') 会同步抛 → 主进程未捕获异常
    expect(() => w.emit('error', new Error('EIO: volume unmounted'))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
