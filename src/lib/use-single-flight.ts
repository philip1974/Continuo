// 同步单飞闸门 hook(race R8 族)。
//
// `disabled={busy}` 是 render 之后才生效的状态:同一事件循环内的双击 / Enter 会在 setBusy(true) 生效前
// 两次进入处理器,发起两次异步操作(如两次 installFromGit → 主进程双 clone,第二个 EEXIST 把成功覆盖成
// 失败)。ref 同步占位:进入即标记,重入直接丢弃;busy state 只负责驱动 UI(disabled / aria-busy)。
// 此前「从 Git URL 安装」的两个表单(设置 → 插件、插件商店)各手写一份 ref + state + finally。

import { useCallback, useRef, useState } from 'react';

export interface SingleFlight {
  /** 任务进行中(驱动 disabled / aria-busy)。 */
  readonly busy: boolean;
  /** 发起任务;已有任务在途时直接返回、不执行 task。task 抛出会原样向外抛,闸门仍释放。 */
  readonly run: (task: () => Promise<void>) => Promise<void>;
}

export function useSingleFlight(): SingleFlight {
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  const run = useCallback(async (task: () => Promise<void>): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
