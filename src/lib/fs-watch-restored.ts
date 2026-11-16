// 本窗内本地分发「目录重新可观察」:Explorer 的 useFsWatcher 在 fs:watch-lost 后重装 watcher 成功时
// emit。断线期间的外部变化 main 不会补推 fs:dir-changed,订阅者(编辑器外部同步)按一次 dir-changed
// 处理,重读该目录下的 clean tab。纯 renderer 内事件,不经 IPC(main 不知道哪次 watchDir 是重装)。

type Listener = (dir: string) => void;

const listeners = new Set<Listener>();

export function emitWatchRestored(dir: string): void {
  for (const l of [...listeners]) {
    try {
      l(dir);
    } catch (err) {
      console.error('[fs] watch-restored listener failed', err);
    }
  }
}

/** 返回 unsubscribe。 */
export function onWatchRestored(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
