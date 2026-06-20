import { describe, it, expect, vi } from 'vitest';
import {
  MAX_WATCHERS,
  createWatcherPool,
  type WatcherCreator,
} from '../../../electron/main/ipc/fs/watch';

// 第九 session R3:WatcherPool「先驱逐 LRU 后调 creator」顺序错误。
//
// 生产 creator 是 `fs.watch(rootPath, ...)`,Node 对**不存在的路径同步抛 ENOENT**。
// 真实时序:Explorer 展开目录 → 该目录被外部删除 / `git checkout` 切分支删掉 →
// renderer 端 debounce 的 WATCH IPC 才到达 main → creator 同步抛。
//
// 旧实现在池满(MAX_WATCHERS=64,大 monorepo)时**先**把最早的健康 watcher
// close + 从池/记账中删除,**再**调 creator(path) 抛错中途退出 → 一个与抛错路径
// 毫不相干的活跃目录 watcher 被静默关闭且永不恢复(该 Explorer 节点不再收到
// dir:changed 增量更新)。属「先回收后分配」顺序错误。
//
// 修复:creator 成功之后才驱逐 LRU,保证 creator 抛错时池状态零变更。
describe('WatcherPool: creator 抛错时不误杀健康 watcher(R3 先建后驱逐)', () => {
  it('池满时 watch 新 path,若 creator 同步抛 → 既有 watcher 全保留、抛给调用方', () => {
    const closes = new Map<string, () => void>();
    const creator: WatcherCreator = vi.fn((path: string) => {
      if (path === '/deleted-during-debounce') {
        const err = new Error('ENOENT: watch failed');
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err; // 模拟 fs.watch 对已删路径同步抛
      }
      const close = vi.fn();
      closes.set(path, close);
      return { close };
    });
    const pool = createWatcherPool(creator);

    // 填满池(全是健康的活跃 watcher)
    for (let i = 0; i < MAX_WATCHERS; i++) pool.watch(`/p${i}`, vi.fn());
    expect(pool.size()).toBe(MAX_WATCHERS);

    // 再 watch 一个会令 creator 抛错的新路径(若先驱逐,会先踢掉 /p0)
    expect(() => pool.watch('/deleted-during-debounce', vi.fn())).toThrow(
      /ENOENT/,
    );

    // 关键断言:最早的健康 watcher /p0 必须仍在池中、未被 close。
    expect(pool.has('/p0')).toBe(true);
    expect(closes.get('/p0')).not.toHaveBeenCalled();
    // 抛错的新路径没有进池;池大小零变化(无健康 watcher 丢失)。
    expect(pool.has('/deleted-during-debounce')).toBe(false);
    expect(pool.size()).toBe(MAX_WATCHERS);
  });

  it('池满时 creator 成功 → 仍正常 LRU 踢最早(回归:修复不破坏正常驱逐)', () => {
    const closes = new Map<string, () => void>();
    const creator: WatcherCreator = vi.fn((path: string) => {
      const close = vi.fn();
      closes.set(path, close);
      return { close };
    });
    const pool = createWatcherPool(creator);

    for (let i = 0; i < MAX_WATCHERS; i++) pool.watch(`/p${i}`, vi.fn());
    pool.watch('/new', vi.fn());

    expect(pool.size()).toBe(MAX_WATCHERS);
    expect(pool.has('/p0')).toBe(false); // 最早被踢
    expect(closes.get('/p0')).toHaveBeenCalledTimes(1);
    expect(pool.has('/new')).toBe(true);
  });

  it('未满时 creator 抛错 → 不影响既有 watcher、抛给调用方', () => {
    const creator: WatcherCreator = vi.fn((path: string) => {
      if (path === '/bad') throw new Error('ENOENT');
      return { close: vi.fn() };
    });
    const pool = createWatcherPool(creator);

    pool.watch('/a', vi.fn());
    expect(() => pool.watch('/bad', vi.fn())).toThrow(/ENOENT/);
    expect(pool.has('/a')).toBe(true);
    expect(pool.has('/bad')).toBe(false);
    expect(pool.size()).toBe(1);
  });
});
