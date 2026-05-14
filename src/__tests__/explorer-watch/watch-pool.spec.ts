import { describe, it, expect, vi } from 'vitest';
import {
  MAX_WATCHERS,
  createWatcherPool,
  type WatcherCreator,
} from '../../../electron/main/ipc/fs/watch';

const makeCreator = (closeMock?: () => void): WatcherCreator => {
  const closes: Array<() => void> = [];
  const fn = vi.fn<WatcherCreator>(() => {
    const close = closeMock ?? vi.fn();
    closes.push(close);
    return { close };
  });
  return Object.assign(fn, { closes });
};

describe('createWatcherPool', () => {
  it('watch(path) → 调 creator 一次', () => {
    const creator = makeCreator();
    const pool = createWatcherPool(creator);
    pool.watch('/a', vi.fn());
    expect(creator).toHaveBeenCalledTimes(1);
    expect(creator).toHaveBeenCalledWith('/a', expect.any(Function));
  });

  it('重复 watch 同 path 共享 watcher(creator 不再调)', () => {
    const creator = makeCreator();
    const pool = createWatcherPool(creator);
    pool.watch('/a', vi.fn());
    pool.watch('/a', vi.fn());
    pool.watch('/a', vi.fn());
    expect(creator).toHaveBeenCalledTimes(1);
  });

  it('重复 watch 同 path 需要对应次数 unwatch 才 close', () => {
    const close = vi.fn();
    const creator: WatcherCreator = vi.fn(() => ({ close }));
    const pool = createWatcherPool(creator);

    pool.watch('/a', vi.fn());
    pool.watch('/a', vi.fn());

    pool.unwatch('/a');
    expect(pool.has('/a')).toBe(true);
    expect(close).not.toHaveBeenCalled();

    pool.unwatch('/a');
    expect(pool.has('/a')).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('has(path) 反映状态', () => {
    const pool = createWatcherPool(makeCreator());
    expect(pool.has('/a')).toBe(false);
    pool.watch('/a', vi.fn());
    expect(pool.has('/a')).toBe(true);
    pool.unwatch('/a');
    expect(pool.has('/a')).toBe(false);
  });

  it('size() 计数正确', () => {
    const pool = createWatcherPool(makeCreator());
    pool.watch('/a', vi.fn());
    pool.watch('/b', vi.fn());
    pool.watch('/c', vi.fn());
    expect(pool.size()).toBe(3);
    pool.unwatch('/b');
    expect(pool.size()).toBe(2);
  });

  it('unwatch(path) 调 watcher.close', () => {
    const close = vi.fn();
    const creator: WatcherCreator = vi.fn(() => ({ close }));
    const pool = createWatcherPool(creator);
    pool.watch('/a', vi.fn());
    pool.unwatch('/a');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('unwatch 不存在的 path → 无操作不抛', () => {
    const pool = createWatcherPool(makeCreator());
    expect(() => pool.unwatch('/nope')).not.toThrow();
    expect(pool.size()).toBe(0);
  });

  it('满 MAX_WATCHERS 时 watch 新 path → LRU 踢最早', () => {
    const closes: Array<() => void> = [];
    const creator: WatcherCreator = vi.fn(() => {
      const close = vi.fn();
      closes.push(close);
      return { close };
    });
    const pool = createWatcherPool(creator);

    for (let i = 0; i < MAX_WATCHERS; i++) {
      pool.watch(`/p${i}`, vi.fn());
    }
    expect(pool.size()).toBe(MAX_WATCHERS);

    // 再加一个,应该踢掉 /p0
    pool.watch('/new', vi.fn());
    expect(pool.size()).toBe(MAX_WATCHERS);
    expect(pool.has('/p0')).toBe(false);
    expect(pool.has('/new')).toBe(true);
    // 踢的 watcher.close 被调
    expect(closes[0]).toHaveBeenCalled();
  });

  it('closeAll() 清空所有 watcher 并调 close', () => {
    const closes: Array<() => void> = [];
    const creator: WatcherCreator = vi.fn(() => {
      const close = vi.fn();
      closes.push(close);
      return { close };
    });
    const pool = createWatcherPool(creator);
    pool.watch('/a', vi.fn());
    pool.watch('/b', vi.fn());
    pool.closeAll();
    expect(pool.size()).toBe(0);
    expect(pool.has('/a')).toBe(false);
    expect(closes[0]).toHaveBeenCalled();
    expect(closes[1]).toHaveBeenCalled();
  });

  it('creator 收到的 onChange 触发后,pool.watch 提供的 cb 被调', () => {
    let triggerChange: (p: string) => void = () => {};
    const creator: WatcherCreator = vi.fn((_path, onChange) => {
      triggerChange = onChange;
      return { close: vi.fn() };
    });
    const pool = createWatcherPool(creator);
    const cb = vi.fn<(p: string) => void>();
    pool.watch('/a', cb);
    triggerChange('/a');
    triggerChange('/a/sub');
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, '/a');
    expect(cb).toHaveBeenNthCalledWith(2, '/a/sub');
  });

  // 回归 issue #20:recursive watcher 在子目录变更时,creator 把实际变更的
  // 子目录路径上抛(而非 watcher 根),pool 透传给 cb,上层(fs.ipc)能广播
  // 给 renderer 精确 invalidate 该子节点。
  it('cb 收到的是 creator 上抛的 changedPath,可与 watch 根不同(#20)', () => {
    let triggerChange: (p: string) => void = () => {};
    const creator: WatcherCreator = vi.fn((_root, onChange) => {
      triggerChange = onChange;
      return { close: vi.fn() };
    });
    const pool = createWatcherPool(creator);
    const cb = vi.fn<(p: string) => void>();
    pool.watch('/workspace/src', cb);
    triggerChange('/workspace/src/engine');
    expect(cb).toHaveBeenCalledWith('/workspace/src/engine');
  });
});
