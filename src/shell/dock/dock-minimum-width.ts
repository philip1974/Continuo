// dock 网格当前的最小宽度(dockview DockviewApi.minimumWidth = 网格根节点按各组 minimumWidth 汇总:并排的组相加、
// 上下叠放的取最大;组默认 100,个别组可另设约束)。窗口变窄时侧栏按它让位(BDD: src/__tests__/explorer-sidebar/)。
// 读实际值而不写死,组约束变化(如某类面板所在组设了更大的最小宽)自动生效。

import { useEffect, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { getDockApi, isDockLayoutRestored, onDockLayoutRestored, subscribeDockApi } from './dock-api-ref';
import { isPopoutRestoreSettling, onPopoutRestoreSettled } from './popout-restore-settle';

/** 网格最小宽度;dock 未就绪 → 0。 */
export function dockMinimumWidth(api: DockviewApi | null = getDockApi()): number {
  const w = api?.minimumWidth;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0;
}

/** 网格最小宽度及其是否已是恢复后的稳定值。 */
export interface DockMinimumWidth {
  readonly width: number;
  /**
   * dock 就绪、布局已恢复(fromJSON / 默认布局)且 popout 恢复已落定。在此之前 width 是空网格(0)或恢复途中的值
   *(恢复失败的 popout 组会被收回主窗网格),依赖它判定「布局变化」的逻辑(侧栏收起)不应把它当基准。
   */
  readonly settled: boolean;
}

function readDockMinimumWidth(api: DockviewApi | null = getDockApi()): DockMinimumWidth {
  const settled = api !== null && api === getDockApi() && isDockLayoutRestored() && !isPopoutRestoreSettling(api);
  return { width: dockMinimumWidth(api), settled };
}

function sameReading(a: DockMinimumWidth, b: DockMinimumWidth): boolean {
  return a.width === b.width && a.settled === b.settled;
}

/**
 * 订阅网格最小宽度:dock api 出现 / 更换、布局恢复完成 / popout 恢复落定、布局变化(组增删 / 移动 / 恢复布局,dockview 合并触发
 * onDidLayoutChange)、窗口缩放(组约束可能随之重算)时重读。
 */
export function useDockMinimumWidth(): DockMinimumWidth {
  const [min, setMinState] = useState(() => readDockMinimumWidth());
  useEffect(() => {
    const setMin = (next: DockMinimumWidth) => setMinState((prev) => (sameReading(prev, next) ? prev : next));
    let subs: Array<{ dispose(): void }> = [];
    const attach = (api: DockviewApi | null) => {
      for (const s of subs) s.dispose();
      subs = [];
      setMin(readDockMinimumWidth(api));
      if (!api) return;
      const read = () => setMin(readDockMinimumWidth(api));
      subs = [api.onDidLayoutChange(read), api.onDidAddGroup(read), api.onDidRemoveGroup(read)];
    };
    attach(getDockApi());
    const stop = subscribeDockApi(attach);
    const reread = () => setMin(readDockMinimumWidth());
    const stopRestored = onDockLayoutRestored(reread);
    const stopPopoutSettled = onPopoutRestoreSettled(reread);
    window.addEventListener('resize', reread);
    return () => {
      stop();
      stopRestored();
      stopPopoutSettled();
      window.removeEventListener('resize', reread);
      for (const s of subs) s.dispose();
    };
  }, []);
  return min;
}
