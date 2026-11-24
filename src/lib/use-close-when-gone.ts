// 弹窗目标从实时列表消失即关闭(R50 / R102 / R103 防过期快照族)。弹窗持有打开瞬间捕获的目标;列表变化后
// 目标不再存在(判定由调用方给:按 id、或 id + version)→ close。判定与 close 取最新渲染的,effect 只随
// 目标与列表变化重跑(同此前各处手写的 useEffect([target, live]))。
import { useEffect, useRef } from 'react';

export function useCloseWhenGone<T, L>(
  target: T | null,
  live: L,
  isPresent: (live: L, target: T) => boolean,
  close: () => void,
): void {
  const latest = useRef({ isPresent, close });
  latest.current = { isPresent, close };
  useEffect(() => {
    if (target !== null && !latest.current.isPresent(live, target)) latest.current.close();
  }, [target, live]);
}
