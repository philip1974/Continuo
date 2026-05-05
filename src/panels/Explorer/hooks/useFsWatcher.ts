import { useEffect, useRef } from 'react';
import { lmApi } from '@/lib/lm-api';
import { diffSets, makeDebouncePerPath } from '../fs-watch-helpers';

const DEBOUNCE_MS = 100;

/**
 * 同步 expandedPaths 到 main 进程的 fs.watch:
 *   新展开的 path → fs.watchDir(path)
 *   折叠的 path  → fs.unwatchDir(path)
 * 订阅 fs:dir-changed 事件,debounce 100ms 后调 onChange(path)。
 *
 * 参数 onChange 通常 = (path) => tree.getItemInstance(path)?.invalidateChildrenIds()
 *
 * Hook 卸载时全 unwatch + 取消 debouncer 避免泄漏。
 */
export function useFsWatcher(
  expandedPaths: ReadonlySet<string>,
  onChange: (path: string) => void,
): void {
  const prevPathsRef = useRef<Set<string>>(new Set());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // diff & 同步 watch / unwatch
  useEffect(() => {
    const prev = prevPathsRef.current;
    const next = expandedPaths;
    const { added, removed } = diffSets(prev, next);
    for (const p of added) void lmApi.fs.watchDir(p);
    for (const p of removed) void lmApi.fs.unwatchDir(p);
    prevPathsRef.current = new Set(next);
  }, [expandedPaths]);

  // 订阅 fs:dir-changed,debounce per path
  useEffect(() => {
    const debounced = makeDebouncePerPath(
      (path) => onChangeRef.current(path),
      DEBOUNCE_MS,
    );
    const unsub = lmApi.fs.onDirChanged((path) => debounced(path));
    return () => {
      unsub();
      debounced.cancel();
    };
  }, []);

  // 卸载时全 unwatch(防 watcher 泄漏)
  useEffect(() => {
    return () => {
      for (const p of prevPathsRef.current) {
        void lmApi.fs.unwatchDir(p);
      }
      prevPathsRef.current = new Set();
    };
  }, []);
}
