import { useEffect, useRef } from 'react';
import { coApi } from '@/lib/co-api';
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
  // race(R37):每个 path 的 watch 尝试代际。watchDir 失败撤销记账(R14)若无代际校验:旧 expand /a
  // 在途时 collapse 再 re-expand /a,第二次 watch 成功后,第一次迟到的 ok:false/reject 会无条件
  // installed.delete('/a') → 账本丢掉已成功安装的 watcher(后续 collapse 不 unwatch / 重复 watch 增
  // refCount = 泄漏/重复引用)。每次 add/remove 对该 path bump 代际,失败撤销仅在仍是最新代际时执行。
  const watchGenRef = useRef<Map<string, number>>(new Map());
  // race(R109):组件卸载标记。watchDir 在途时卸载,迟到的 watch 成功后须补发 unwatch 抵消(见下)。
  const cancelledRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // diff & 同步 watch / unwatch。prevPathsRef 是「已安装 watch」集合(就地 mutate),区别于
  // 「期望 expanded」(expandedPaths 参数)。
  useEffect(() => {
    const installed = prevPathsRef.current;
    const watchGen = watchGenRef.current;
    const bumpGen = (p: string): number => {
      const g = (watchGen.get(p) ?? 0) + 1;
      watchGen.set(p, g);
      return g;
    };
    const { added, removed } = diffSets(installed, expandedPaths);
    for (const p of removed) {
      installed.delete(p);
      // race(R37):bump 代际作废任何对该 path 在途的 add —— 其迟到的失败撤销不再误删后续记账。
      bumpGen(p);
      void coApi.fs.unwatchDir(p);
    }
    for (const p of added) {
      // race(R14):watchDir 是异步 IPC。此前 effect 立即把 prevPathsRef 设为 next,等于在 main
      // 确认 watcher 创建前就标记「已 watch」;若 fs.watch 因 ENOENT/EACCES/资源上限返回 ok:false
      // 或 reject,该目录被永久记为已 watch、expandedPaths 不变时永不重试 → 长期无增量刷新。
      // 改:乐观加入 installed(防同一 path 并发重复 watch),失败则撤销记账,使后续 effect 重试。
      installed.add(p);
      // race(R37):捕获本次尝试代际;失败撤销仅当仍是该 path 最新代际时执行(否则会删掉
      // collapse→re-expand 后第二次成功安装的记账,造成 watcher 泄漏/重复引用)。
      const myGen = bumpGen(p);
      void (async () => {
        try {
          const r = await coApi.fs.watchDir(p);
          if (r.ok) {
            // race(R109):watchDir 在途期间该 path 已不再被需要 —— 组件卸载(cancelledRef),或
            // collapse 且未 re-expand(installed 已不含 p)。两种情况下卸载/折叠路径都已 fire 过
            // unwatchDir(p),但该 unwatch 可能先于本 watch 到达 main → unwatch 落空(watcher 尚未
            // 建)、watch 后建成孤儿 watcher,main 继续推 dir-changed,反复展开/切 workspace 累积
            // 无主 watcher。补发 unwatchDir(p) 抵消:main 的 owner-guarded unwatch 对已释放/未建
            // 路径是 no-op,故 double-unwatch 安全。re-expand 时 installed.has(p) 为真 → 不补发
            // (现有 watch/unwatch 记账已平衡)。
            if (cancelledRef.current || !installed.has(p)) {
              void coApi.fs.unwatchDir(p);
            }
          } else if (watchGen.get(p) === myGen) {
            installed.delete(p);
          }
        } catch {
          if (watchGen.get(p) === myGen) installed.delete(p);
        }
      })();
    }
  }, [expandedPaths]);

  // 订阅 fs:dir-changed,debounce per path
  useEffect(() => {
    const debounced = makeDebouncePerPath(
      (path) => onChangeRef.current(path),
      DEBOUNCE_MS,
    );
    const unsub = coApi.fs.onDirChanged((path) => debounced(path));
    return () => {
      unsub();
      debounced.cancel();
    };
  }, []);

  // 卸载时全 unwatch(防 watcher 泄漏)
  useEffect(() => {
    cancelledRef.current = false; // race(R109):(重)挂载复位,StrictMode 双挂 / HMR 不误判已卸载
    return () => {
      cancelledRef.current = true; // race(R109):令在途 watchDir 成功后补发 unwatch 抵消孤儿
      for (const p of prevPathsRef.current) {
        void coApi.fs.unwatchDir(p);
      }
      prevPathsRef.current = new Set();
    };
  }, []);
}
