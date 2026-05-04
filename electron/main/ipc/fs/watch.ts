// Watcher 池(M-Explorer Step 6)。
// 纯函数工厂 — creator 注入便于单测;生产端注入 fs.watch 实现。
//
// 设计:
// - 只 watch 已展开的目录(VSCode 风,大 monorepo 不爆 watcher)
// - MAX_WATCHERS=64 上限,LRU 踢最早(借鉴 Mind 风,防资源泄漏)
// - 同 path 重复 watch 幂等(creator 只调一次)
// - cb 是 renderer 端注入的"通知函数",pool 内部不知道 IPC

export const MAX_WATCHERS = 64;

export interface Watcher {
  close: () => void;
}

export type WatcherCreator = (
  path: string,
  onChange: () => void,
) => Watcher;

export interface WatcherPool {
  watch: (path: string, onChange: () => void) => void;
  unwatch: (path: string) => void;
  has: (path: string) => boolean;
  size: () => number;
  closeAll: () => void;
}

export function createWatcherPool(creator: WatcherCreator): WatcherPool {
  const watchers = new Map<string, Watcher>();
  const order: string[] = []; // LRU,head 是最早

  return {
    watch(path, onChange) {
      if (watchers.has(path)) return; // 幂等

      // 满了 → LRU 踢
      if (watchers.size >= MAX_WATCHERS) {
        const oldest = order.shift();
        if (oldest !== undefined) {
          watchers.get(oldest)?.close();
          watchers.delete(oldest);
        }
      }

      const w = creator(path, onChange);
      watchers.set(path, w);
      order.push(path);
    },

    unwatch(path) {
      const w = watchers.get(path);
      if (!w) return;
      w.close();
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
      for (const w of watchers.values()) w.close();
      watchers.clear();
      order.length = 0;
    },
  };
}
