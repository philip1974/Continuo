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

  // ── 审计 P2:owner-aware 释放(硬关窗清理) ──────────────────
  describe('unwatchByOwner(windowId) 释放该窗口持有的引用', () => {
    it('关窗释放本窗口所有 path 引用并 close', () => {
      const closes: Array<() => void> = [];
      const creator: WatcherCreator = vi.fn(() => {
        const close = vi.fn();
        closes.push(close);
        return { close };
      });
      const pool = createWatcherPool(creator);

      pool.watch('/a', vi.fn(), 1);
      pool.watch('/b', vi.fn(), 1);
      expect(pool.size()).toBe(2);

      pool.unwatchByOwner(1);
      expect(pool.size()).toBe(0);
      expect(closes[0]).toHaveBeenCalledTimes(1);
      expect(closes[1]).toHaveBeenCalledTimes(1);
    });

    it('共享 path:另一窗口仍持有时关一窗不 close,引用归零才 close', () => {
      const close = vi.fn();
      const creator: WatcherCreator = vi.fn(() => ({ close }));
      const pool = createWatcherPool(creator);

      pool.watch('/shared', vi.fn(), 1); // 窗口 1
      pool.watch('/shared', vi.fn(), 2); // 窗口 2(共享 watcher)
      expect(creator).toHaveBeenCalledTimes(1);

      pool.unwatchByOwner(1);
      expect(pool.has('/shared')).toBe(true); // 窗口 2 还在
      expect(close).not.toHaveBeenCalled();

      pool.unwatchByOwner(2);
      expect(pool.has('/shared')).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('同窗口对同 path 多次 watch → unwatchByOwner 全部抵消', () => {
      const close = vi.fn();
      const creator: WatcherCreator = vi.fn(() => ({ close }));
      const pool = createWatcherPool(creator);

      pool.watch('/a', vi.fn(), 7);
      pool.watch('/a', vi.fn(), 7); // 同窗口再 watch,refCount=2
      pool.unwatchByOwner(7);
      expect(pool.has('/a')).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('显式 unwatch(path, ownerId) 后 unwatchByOwner 不重复 decrement', () => {
      const close = vi.fn();
      const creator: WatcherCreator = vi.fn(() => ({ close }));
      const pool = createWatcherPool(creator);

      pool.watch('/a', vi.fn(), 1);
      pool.watch('/a', vi.fn(), 1); // refCount=2
      pool.unwatch('/a', 1); // 正常 unmount 释放一次 → refCount=1
      expect(pool.has('/a')).toBe(true);

      pool.unwatchByOwner(1); // 只剩 1 次该 decrement,归零 close
      expect(pool.has('/a')).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('unwatchByOwner 未知窗口 → 无操作不抛', () => {
      const pool = createWatcherPool(makeCreator());
      expect(() => pool.unwatchByOwner(999)).not.toThrow();
    });

    it('无 ownerId 的 watch 不被 unwatchByOwner 影响(向后兼容)', () => {
      const close = vi.fn();
      const creator: WatcherCreator = vi.fn(() => ({ close }));
      const pool = createWatcherPool(creator);
      pool.watch('/a', vi.fn()); // 不传 ownerId
      pool.unwatchByOwner(1);
      expect(pool.has('/a')).toBe(true);
      expect(close).not.toHaveBeenCalled();
    });

    it('LRU 驱逐某 path 后,他窗重建同 path → 原窗关窗不误杀新 watcher(topic49 第十二轮 P2-GG)', () => {
      // 窗口 1 watch 满 MAX_WATCHERS 个 path;再 watch 一个触发 LRU 踢掉 /p0。
      // 旧实现驱逐只删 watchers 不清 ownerPaths{1}[/p0] → 窗口 2 重建 /p0 后,
      // 窗口 1 关窗 unwatchByOwner(1) 按陈旧记账误减窗口 2 的 /p0 watcher 把它 close。
      const closes = new Map<string, () => void>();
      const creator: WatcherCreator = vi.fn((path: string) => {
        const close = vi.fn();
        closes.set(path, close);
        return { close };
      });
      const pool = createWatcherPool(creator);

      for (let i = 0; i < MAX_WATCHERS; i++) pool.watch(`/p${i}`, vi.fn(), 1);
      pool.watch('/extra', vi.fn(), 1); // LRU 踢掉最早的 /p0
      expect(pool.has('/p0')).toBe(false);

      // 窗口 2 重建 /p0(同工作区另开)
      const beforeRebuildClose = closes.get('/p0');
      pool.watch('/p0', vi.fn(), 2);
      expect(pool.has('/p0')).toBe(true);
      const rebuiltClose = closes.get('/p0'); // creator 又跑一次 → 新 close
      expect(rebuiltClose).not.toBe(beforeRebuildClose);

      // 窗口 1 关闭 → 不应误杀窗口 2 重建的 /p0
      pool.unwatchByOwner(1);
      expect(pool.has('/p0')).toBe(true);
      expect(rebuiltClose).not.toHaveBeenCalled();

      // 窗口 2 正常关闭才释放
      pool.unwatchByOwner(2);
      expect(pool.has('/p0')).toBe(false);
      expect(rebuiltClose).toHaveBeenCalledTimes(1);
    });
  });

  it('重复 watch 已存在 path 刷新 LRU 位置,不被优先驱逐(审计 P3)', () => {
    const closes: Array<() => void> = [];
    const creator: WatcherCreator = vi.fn(() => {
      const close = vi.fn();
      closes.push(close);
      return { close };
    });
    const pool = createWatcherPool(creator);

    pool.watch('/p0', vi.fn()); // 最早
    for (let i = 1; i < MAX_WATCHERS; i++) pool.watch(`/p${i}`, vi.fn());
    // 重新 watch /p0 → 应刷新到队尾,不再是 LRU 头
    pool.watch('/p0', vi.fn());
    // 此时 /p0 refCount=2;先 unwatch 一次让它回到单引用但仍在队尾
    pool.unwatch('/p0');

    pool.watch('/new', vi.fn()); // 触发驱逐,应踢 /p1(现存最早),不是 /p0
    expect(pool.has('/p0')).toBe(true);
    expect(pool.has('/p1')).toBe(false);
  });
});
