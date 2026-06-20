// Watcher 池(M-Explorer Step 6)。
// 纯函数工厂 — creator 注入便于单测;生产端注入 fs.watch 实现。
//
// 设计:
// - 只 watch 已展开的目录(VSCode 风,大 monorepo 不爆 watcher)
// - MAX_WATCHERS=64 上限,LRU 踢最早(借鉴 Mind 风,防资源泄漏)
// - 同 path 重复 watch 共享 watcher,按引用计数释放(creator 只调一次)
// - cb 是 renderer 端注入的"通知函数",pool 内部不知道 IPC

export const MAX_WATCHERS = 64;

export interface Watcher {
  close: () => void;
}

/**
 * onChange(changedPath):creator 实际监听到变更时调用,传"真实变更的目录"。
 * - non-recursive watcher:changedPath = watcher 根 path(变更必发生在该目录直接子)
 * - recursive watcher(macOS/Win):changedPath = 根 path 拼上 callback 给的相对子路径
 *   的目录部分,便于上层精确广播,renderer 才能 invalidate 正确节点(见 issue #20)
 */
export type WatcherCreator = (
  path: string,
  onChange: (changedPath: string) => void,
) => Watcher;

export interface WatcherPool {
  /**
   * ownerId:发起 watch 的窗口 id。传入后,可用 unwatchByOwner 在该窗口硬关闭/崩溃
   * (React unmount cleanup 不保证执行)时批量释放它持有的全部 watcher 引用。
   */
  watch: (
    path: string,
    onChange: (changedPath: string) => void,
    ownerId?: number,
  ) => void;
  unwatch: (path: string, ownerId?: number) => void;
  /** 释放某窗口持有的所有 watch 引用(关窗清理,审计 P2)。 */
  unwatchByOwner: (ownerId: number) => void;
  has: (path: string) => boolean;
  size: () => number;
  closeAll: () => void;
}

export function createWatcherPool(creator: WatcherCreator): WatcherPool {
  const watchers = new Map<string, { watcher: Watcher; refCount: number }>();
  const order: string[] = []; // LRU,head 是最早
  // windowId → (path → 该窗口对此 path 的引用次数)。关窗时按此批量 decrement。
  const ownerPaths = new Map<number, Map<string, number>>();

  function touchOrder(path: string): void {
    const idx = order.indexOf(path);
    if (idx >= 0) order.splice(idx, 1);
    order.push(path);
  }

  function trackOwner(path: string, ownerId: number, delta: number): void {
    let m = ownerPaths.get(ownerId);
    if (!m) {
      if (delta <= 0) return;
      m = new Map();
      ownerPaths.set(ownerId, m);
    }
    const next = (m.get(path) ?? 0) + delta;
    if (next > 0) m.set(path, next);
    else m.delete(path);
    if (m.size === 0) ownerPaths.delete(ownerId);
  }

  // LRU 强制驱逐某 path 时,把它从**所有** owner 的记账里清掉。watcher 被强关后
  // 该 path 在 watchers 里已不存在;若某 owner 的 ownerPaths 仍残留对它的记账,等到
  // 另一窗口重建同 path 的 watcher 后,前者关窗 unwatchByOwner 会按陈旧记账误减新
  // watcher 的 refCount 把它 close → 跨窗口误杀活跃 watcher(同工作区双窗 + >64 目录)。
  function purgeOwnerAccounting(path: string): void {
    for (const [ownerId, m] of ownerPaths) {
      if (m.delete(path) && m.size === 0) ownerPaths.delete(ownerId);
    }
  }

  // 内部:对 path 减一引用,归零则 close。不碰 ownerPaths(由调用方负责)。
  function decrementRef(path: string): void {
    const entry = watchers.get(path);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    entry.watcher.close();
    watchers.delete(path);
    const idx = order.indexOf(path);
    if (idx >= 0) order.splice(idx, 1);
  }

  return {
    watch(path, onChange, ownerId) {
      const entry = watchers.get(path);
      if (entry) {
        entry.refCount += 1;
        touchOrder(path); // 重复 watch 视为"最近使用",刷新 LRU 位置(审计 P3)
        if (ownerId !== undefined) trackOwner(path, ownerId, 1);
        return;
      }

      // 先建新 watcher,**成功之后**才驱逐 LRU(R3「先回收后分配」顺序错误修复)。
      // 生产 creator 是 fs.watch(path),Node 对不存在/无权目录**同步抛 ENOENT**:
      // 旧实现先驱逐 LRU(close + 删池 + purge 记账)再调 creator,creator 抛错时
      // 已经 close 掉一个与抛错路径毫不相干的健康活跃 watcher 却没建成新的 →
      // 该目录静默永久失去 fs 事件。改为分配成功才回收,保证 creator 抛错时池
      // 状态零变更(错误原样抛给 WATCH handler)。
      const w = creator(path, onChange);

      // 满了 → LRU 踢
      if (watchers.size >= MAX_WATCHERS) {
        const oldest = order.shift();
        if (oldest !== undefined) {
          watchers.get(oldest)?.watcher.close();
          watchers.delete(oldest);
          // 同步清掉所有 owner 对被驱逐 path 的记账,否则后续 unwatchByOwner 会按
          // 陈旧记账误减他窗重建的同 path watcher(见 purgeOwnerAccounting 注释)。
          purgeOwnerAccounting(oldest);
        }
      }

      watchers.set(path, { watcher: w, refCount: 1 });
      order.push(path);
      if (ownerId !== undefined) trackOwner(path, ownerId, 1);
    },

    unwatch(path, ownerId) {
      if (!watchers.has(path)) return;
      if (ownerId !== undefined) {
        // 只有该 owner 确实持有此 path 才减引用。否则 no-op:窗口 A 展开 P 时
        // creator(fs.watch) 因目录刚被删同步抛错 → A 从未把 P 记进 ownerPaths,
        // 但 renderer 的 prevPathsRef 已含 P;之后窗口 B 成功 watch 同路径 P,A 折叠/
        // 关窗发来 unwatch(P, A) —— 若无条件 decrementRef 就会误减并 close 掉 B 的
        // 活跃 watcher,B 静默失去该目录 fs 事件(codex 复审 F3)。
        const held = ownerPaths.get(ownerId)?.get(path) ?? 0;
        if (held <= 0) return;
        decrementRef(path);
        trackOwner(path, ownerId, -1);
        return;
      }
      // ownerId 缺省:保留旧无 owner 语义(单测/无窗口上下文)。
      decrementRef(path);
    },

    unwatchByOwner(ownerId) {
      const m = ownerPaths.get(ownerId);
      if (!m) return;
      for (const [path, count] of m) {
        for (let i = 0; i < count; i++) decrementRef(path);
      }
      ownerPaths.delete(ownerId);
    },

    has(path) {
      return watchers.has(path);
    },

    size() {
      return watchers.size;
    },

    closeAll() {
      for (const entry of watchers.values()) entry.watcher.close();
      watchers.clear();
      order.length = 0;
      ownerPaths.clear();
    },
  };
}
