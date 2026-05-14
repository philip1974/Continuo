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
  watch: (path: string, onChange: (changedPath: string) => void) => void;
  unwatch: (path: string) => void;
  has: (path: string) => boolean;
  size: () => number;
  closeAll: () => void;
}

export function createWatcherPool(creator: WatcherCreator): WatcherPool {
  const watchers = new Map<string, { watcher: Watcher; refCount: number }>();
  const order: string[] = []; // LRU,head 是最早

  return {
    watch(path, onChange) {
      const entry = watchers.get(path);
      if (entry) {
        entry.refCount += 1;
        return;
      }

      // 满了 → LRU 踢
      if (watchers.size >= MAX_WATCHERS) {
        const oldest = order.shift();
        if (oldest !== undefined) {
          watchers.get(oldest)?.watcher.close();
          watchers.delete(oldest);
        }
      }

      const w = creator(path, onChange);
      watchers.set(path, { watcher: w, refCount: 1 });
      order.push(path);
    },

    unwatch(path) {
      const entry = watchers.get(path);
      if (!entry) return;
      entry.refCount -= 1;
      if (entry.refCount > 0) return;
      entry.watcher.close();
      watchers.delete(path);
      const idx = order.indexOf(path);
      if (idx >= 0) order.splice(idx, 1);
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
    },
  };
}
