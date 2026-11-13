import { useEffect, useRef, useState } from 'react';

/**
 * 定时轮询一个外部快照(没有订阅接口的数据源,如 user plugin manager 的已装列表)。
 * 每次读到的值经 `same` 与当前值比较,相同则保持原引用 —— 否则每个 tick 都换引用,使用方每秒整页重渲。
 * 挂载时立即读一次(数据源可能在组件挂载后才初始化完)。返回 [快照, 立即刷新]。
 * Marketplace 的已装 id 集合与设置页的插件列表此前各手写一份。
 */
export function usePolledSnapshot<T>(
  read: () => T,
  same: (prev: T, next: T) => boolean,
  intervalMs = 1000,
): readonly [T, () => void] {
  const [snap, setSnap] = useState<T>(read);
  // read / same 每次渲染可能是新函数;interval 回调读 ref,不因此重建定时器。
  const latest = useRef({ read, same });
  latest.current = { read, same };
  const refreshRef = useRef(() => {
    const next = latest.current.read();
    setSnap((prev) => (latest.current.same(prev, next) ? prev : next));
  });
  useEffect(() => {
    const refresh = refreshRef.current;
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return [snap, refreshRef.current];
}
