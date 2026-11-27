// 工作区根消失 / 恢复时刷新资源管理器(卷卸载后挂回、根被改名再改回)。
//
// 此前只靠根 watcher 的 dir-changed:卷卸载期间事件不一定到(或到时挂载点还在),资源管理器一直列着卸载前的全部文件;
// 挂回后事件也可能早于卷内容就位,之后不再有事件 → 列表停在空 / 过期状态。
// - main 推 fs:root-presence-changed(本根)→ 先 listDir 探测根:读得到 → 整树刷新(根 + 已展开目录);读不到 → 只刷新根,
//   根读取失败的内联提示(原因 + 重试)取代过期列表(不逐个刷新已展开子目录:它们必然同样失败,只会多出一串错误播报)。
// - 根处于读取失败状态时低频复查(ROOT_UNAVAILABLE_RECHECK_MS 一次 + 窗口获得焦点时):探测到根读得到 → 整树刷新,
//   不依赖挂回时的文件事件。
import { useEffect, useRef } from 'react';
import { coApi } from '@/lib/co-api';
import { pathEquals } from '@/lib/path-cross';

export const ROOT_UNAVAILABLE_RECHECK_MS = 5000;

async function rootReadable(root: string): Promise<boolean> {
  try {
    return (await coApi.fs.listDir(root)).ok;
  } catch {
    return false;
  }
}

export function useRootPresenceRefresh(
  root: string,
  rootFailed: boolean,
  refreshRoot: () => void,
  refreshAll: () => void,
): void {
  const refreshRootRef = useRef(refreshRoot);
  refreshRootRef.current = refreshRoot;
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;

  useEffect(() => {
    let cancelled = false;
    const unsub = coApi.fs.onRootPresenceChanged((p) => {
      if (!pathEquals(p, root)) return;
      void rootReadable(root).then((ok) => {
        if (cancelled) return;
        if (ok) refreshAllRef.current();
        else refreshRootRef.current();
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [root]);

  useEffect(() => {
    if (!rootFailed) return;
    let cancelled = false;
    let running = false;
    const recheck = (): void => {
      if (running) return;
      running = true;
      void rootReadable(root).then((ok) => {
        running = false;
        if (!cancelled && ok) refreshAllRef.current();
      });
    };
    const timer = setInterval(recheck, ROOT_UNAVAILABLE_RECHECK_MS);
    window.addEventListener('focus', recheck);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', recheck);
    };
  }, [root, rootFailed]);
}
