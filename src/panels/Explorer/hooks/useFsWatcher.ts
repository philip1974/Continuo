import { useCallback, useEffect, useRef } from 'react';
import { coApi } from '@/lib/co-api';
import { emitWatchRestored } from '@/lib/fs-watch-restored';
import { isSameOrInsidePath } from '@/lib/path-cross';
import { diffSets, makeDebouncePerPath } from '../fs-watch-helpers';

const DEBOUNCE_MS = 100;
// 持续事件(如目录内持续创建/删除临时文件)下纯 trailing debounce 永不触发;至多每 1s 刷新一次。
const DEBOUNCE_MAX_WAIT_MS = 1000;
// fs:watch-lost 重装退避:首次 2s,同一 path 每次失效逐次翻倍,上限 60s(卷持续断开时不紧密重试)。重装成功**不**复位:
// 卷反复抖动(装上即失效)时复位会退化成每 2s 一次的紧密重装;只在目录折叠(不再需要 watch)时复位。
const LOST_RETRY_BASE_MS = 2000;
const LOST_RETRY_MAX_MS = 60_000;

function bumpGen(watchGen: Map<string, number>, p: string): number {
  const g = (watchGen.get(p) ?? 0) + 1;
  watchGen.set(p, g);
  return g;
}

/**
 * 同步 expandedPaths 到 main 进程的 fs.watch:
 *   新展开的 path → fs.watchDir(path)
 *   折叠的 path  → fs.unwatchDir(path)
 * 订阅 fs:dir-changed 事件,debounce 100ms(持续事件下至多每 1s 一次)后调 onChange(path);
 * changeOnly(仅内容变化,目录列表不变)事件不触发刷新。
 *
 * 参数 onChange 通常 = (path) => tree.getItemInstance(path)?.invalidateChildrenIds()
 *
 * Hook 卸载时全 unwatch + 取消 debouncer 避免泄漏。
 *
 * root(可选):本 Explorer 的工作区根。fs:dir-changed 是全窗口广播(其它窗口工作区的目录变化
 * 同样送达),传入后 root 外路径在进入 debouncer 前丢弃 —— 它们不可能对应本树节点,却会让
 * onChange 走 invalidation→listDir 白做 IPC + 读盘(性能审计 #2)。不影响其它 onDirChanged 订阅者。
 */
export function useFsWatcher(
  expandedPaths: ReadonlySet<string>,
  onChange: (path: string) => void,
  root?: string,
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
  // 读最新 root 而不重订阅(重订阅会 cancel debouncer 丢掉在途刷新)。
  const rootRef = useRef(root);
  rootRef.current = root;
  // watch-lost 延迟重装时判断「仍展开」用最新 expandedPaths。
  const expandedRef = useRef(expandedPaths);
  expandedRef.current = expandedPaths;
  // watch-lost:每 path 连续失效次数(决定退避延迟),折叠时复位。
  const lostCountRef = useRef<Map<string, number>>(new Map());
  // watch-lost:每 path 待重装定时器;折叠 / 卸载时取消。
  const lostTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // watch-lost:经历过失效、尚未恢复的 path。任何 installWatch 对其的首次成功(退避定时器,或退避期间
  // 展开别的目录 / 折叠重开令普通 diff 抢先重装)都补刷新 + emitWatchRestored 并清标记;否则抢先重装
  // 成功后定时器见已安装即退出,断线期间的变化永不可见。
  const pendingRestoreRef = useRef<Set<string>>(new Set());
  // watch-lost:按退避续排该 path 的重装(由 watch-lost effect 赋值;installWatch 失败续排用)。
  const scheduleLostRetryRef = useRef<(p: string) => void>(() => {});

  // 安装一个 path 的 watch(diff effect 与 watch-lost 重装共用);只读 ref,引用稳定。
  // 成功(仍需要该 watch)且 path 待恢复 → 补刷新 + 本地分发「重新可观察」。
  // 失败(仍是最新代际,已撤销记账)且 path 失效未恢复、仍展开、未卸载 → 续排退避重试。不区分调用方:
  // 退避期间折叠(定时器已清)再重新展开时,普通 diff 的安装失败同样须续排,否则卷恢复后永不重试。
  const installWatch = useCallback((p: string): void => {
    const installed = prevPathsRef.current;
    const watchGen = watchGenRef.current;
    // race(R14):watchDir 是异步 IPC。此前 effect 立即把 prevPathsRef 设为 next,等于在 main
    // 确认 watcher 创建前就标记「已 watch」;若 fs.watch 因 ENOENT/EACCES/资源上限返回 ok:false
    // 或 reject,该目录被永久记为已 watch、expandedPaths 不变时永不重试 → 长期无增量刷新。
    // 改:乐观加入 installed(防同一 path 并发重复 watch),失败则撤销记账,使后续 effect 重试。
    installed.add(p);
    // race(R37):捕获本次尝试代际;失败撤销仅当仍是该 path 最新代际时执行(否则会删掉
    // collapse→re-expand 后第二次成功安装的记账,造成 watcher 泄漏/重复引用)。
    const myGen = bumpGen(watchGen, p);
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
          } else if (watchGen.get(p) === myGen && pendingRestoreRef.current.delete(p)) {
            onChangeRef.current(p);
            emitWatchRestored(p);
          }
          return;
        }
      } catch {
        // 落到下方失败撤销(reject 与 ok:false 同处理)
      }
      if (watchGen.get(p) !== myGen) return;
      installed.delete(p);
      if (!cancelledRef.current && pendingRestoreRef.current.has(p) && expandedRef.current.has(p)) {
        scheduleLostRetryRef.current(p);
      }
    })();
  }, []);

  // diff & 同步 watch / unwatch。prevPathsRef 是「已安装 watch」集合(就地 mutate),区别于
  // 「期望 expanded」(expandedPaths 参数)。
  useEffect(() => {
    const installed = prevPathsRef.current;
    const { added, removed } = diffSets(installed, expandedPaths);
    for (const p of removed) {
      installed.delete(p);
      // race(R37):bump 代际作废任何对该 path 在途的 add —— 其迟到的失败撤销不再误删后续记账。
      bumpGen(watchGenRef.current, p);
      void coApi.fs.unwatchDir(p);
    }
    // 折叠即复位 watch-lost 退避并取消待重装:lost 已把 path 移出账本,diffSets 不会将其列入 removed,
    // 故按「不再展开」判定,不论是否在账本中(否则折叠—重开后的下一次失效沿用旧退避)。
    for (const p of lostCountRef.current.keys()) {
      if (!expandedPaths.has(p)) lostCountRef.current.delete(p);
    }
    for (const [p, t] of lostTimersRef.current) {
      if (expandedPaths.has(p)) continue;
      clearTimeout(t);
      lostTimersRef.current.delete(p);
    }
    for (const p of added) installWatch(p);
  }, [expandedPaths, installWatch]);

  // 订阅 fs:dir-changed,debounce per path
  useEffect(() => {
    const debounced = makeDebouncePerPath(
      (path) => onChangeRef.current(path),
      DEBOUNCE_MS,
      DEBOUNCE_MAX_WAIT_MS,
    );
    const unsub = coApi.fs.onDirChanged((path, _files, changeOnly) => {
      // 性能:仅内容变化(无新建/删除/改名)→ 目录列表不变,不必整目录 listDir。
      if (changeOnly === true) return;
      const r = rootRef.current;
      if (r !== undefined && !isSameOrInsidePath(r, path)) return;
      debounced(path);
    });
    return () => {
      unsub();
      debounced.cancel();
    };
  }, []);

  // 订阅 fs:watch-lost:main 因 FSWatcher error 驱逐了本窗持有的 watcher,账本仍记为已安装则 diff 永不重装、
  // 该展开目录永久不刷新。移出账本 + 作废在途尝试 + 立即刷新一次;退避延迟后仍展开且未被重装才重新 watchDir。
  // 重装失败(卷仍不可用)→ 继续按退避重试,直到成功或折叠/卸载;成功 → 再刷新一次并本地分发
  // 「重新可观察」(断线期间的变化 main 不会补推 dir-changed)。
  useEffect(() => {
    const timers = lostTimersRef.current;
    const schedule = (p: string): void => {
      const n = lostCountRef.current.get(p) ?? 0;
      lostCountRef.current.set(p, n + 1);
      clearTimeout(timers.get(p));
      timers.set(
        p,
        setTimeout(
          () => {
            timers.delete(p);
            if (!expandedRef.current.has(p) || prevPathsRef.current.has(p)) return;
            installWatch(p);
          },
          Math.min(LOST_RETRY_BASE_MS * 2 ** n, LOST_RETRY_MAX_MS),
        ),
      );
    };
    scheduleLostRetryRef.current = schedule;
    const unsub = coApi.fs.onWatchLost((p) => {
      const installed = prevPathsRef.current;
      if (!installed.has(p)) return;
      installed.delete(p);
      bumpGen(watchGenRef.current, p);
      pendingRestoreRef.current.add(p);
      onChangeRef.current(p);
      schedule(p);
    });
    return () => {
      unsub();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [installWatch]);

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
