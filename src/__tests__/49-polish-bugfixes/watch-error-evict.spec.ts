// 健壮性(独立审计):fs.ipc 的生产 watcher creator 只保存 `close()`,未监听 FSWatcher 的异步
// 'error' 事件。网络盘 / 可移动卷断开、被 watch 目录失效时 FSWatcher emit('error'),EventEmitter
// 无 error 监听即抛出 → 主进程未捕获异常崩溃。修复:creator 注册 error 监听(console.warn),
// 并回调池把失效 watcher 关闭、移出池与 owner 记账(复用 LRU 驱逐同款清理),不崩溃。

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatcherPool, type WatcherCreator } from '../../../electron/main/ipc/fs/watch';

const mocks = vi.hoisted(() => ({
  watchers: [] as Array<EventEmitter & { close: () => void }>,
  windows: new Map<number, { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromId: (id: number) => mocks.windows.get(id) ?? null },
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
  mocks.windows.clear();
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

// 驱逐后 renderer 仍以为已安装 → 不再 watchDir,该展开目录永久不刷新。池驱逐时把持有者窗口报给 onLost,
// fs.ipc 据此向这些窗口推 fs:watch-lost,renderer 移出账本并退避重装。
describe('WatcherPool:失效驱逐上报持有者窗口(onLost)', () => {
  it('onError → onLost(path, 持有该 path 的窗口 id);LRU / 正常 unwatch 不上报', () => {
    const reports = new Map<string, (err: unknown) => void>();
    const onLost = vi.fn();
    const pool = createWatcherPool((p, _onChange, onError) => {
      reports.set(p, onError);
      return { close: vi.fn() };
    }, onLost);
    pool.watch('/vol/dir', vi.fn(), 1);
    pool.watch('/vol/dir', vi.fn(), 2);
    pool.watch('/other', vi.fn(), 3);
    pool.unwatch('/other', 3);
    expect(onLost).not.toHaveBeenCalled();

    reports.get('/vol/dir')!(new Error('EIO'));
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('/vol/dir', [1, 2]);

    // 迟到的重复 error 不重复上报
    reports.get('/vol/dir')!(new Error('EIO again'));
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('notifyWatchLost 只推给持有者窗口(跳过已销毁 / 不存在),send 抛错不中断', async () => {
    const { notifyWatchLost } = await import('../../../electron/main/ipc/fs.ipc');
    const { FS_CHANNELS } = await import('../../../electron/shared/fs-channels');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w1 = { isDestroyed: () => false, webContents: { send: vi.fn(() => { throw new Error('destroyed'); }) } };
    const w2 = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const w3 = { isDestroyed: () => true, webContents: { send: vi.fn() } };
    const w4 = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    mocks.windows.set(1, w1);
    mocks.windows.set(2, w2);
    mocks.windows.set(3, w3);
    mocks.windows.set(4, w4);

    expect(() => notifyWatchLost('/vol/dir', [1, 2, 3, 99])).not.toThrow();
    expect(w2.webContents.send).toHaveBeenCalledWith(FS_CHANNELS.WATCH_LOST, { path: '/vol/dir' });
    expect(w3.webContents.send).not.toHaveBeenCalled();
    expect(w4.webContents.send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
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

// 性能:生产 creator 把 fs.watch 回调的 filename 末段名随 changedPath 一并上抛(缺 filename → undefined),
// 合并器据此按目录聚合文件名,renderer 只重读命中的 clean tab。
describe('fs.ipc 生产 creator:上抛变更文件名', () => {
  it('有 filename → onChange(变更目录, 末段名);无 filename → onChange(根, undefined)', async () => {
    const fs = await import('node:fs');
    const nodePath = await import('node:path');
    const { createFsWatcher } = await import('../../../electron/main/ipc/fs.ipc');
    const onChange = vi.fn();
    createFsWatcher('/r', onChange, vi.fn());
    const calls = (fs.watch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const cb = calls.at(-1)![2] as (ev: string, filename: string | null) => void;
    cb('change', 'sub/a.md');
    cb('rename', 'b.md');
    cb('rename', null);
    expect(onChange.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [nodePath.join('/r', 'sub'), 'a.md'],
      ['/r', 'b.md'],
      ['/r', undefined],
    ]);
  });
});
