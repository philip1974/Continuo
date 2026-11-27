// dock 网格当前的最小宽度(dockview DockviewApi.minimumWidth = 网格根节点按各组 minimumWidth 汇总:并排的组相加、
// 上下叠放的取最大;组默认 100,个别组可另设约束)。窗口变窄时侧栏按它让位(BDD: src/__tests__/explorer-sidebar/)。
// 读实际值而不写死,组约束变化(如某类面板所在组设了更大的最小宽)自动生效。

import { useEffect, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { getDockApi, subscribeDockApi } from './dock-api-ref';

/** 网格最小宽度;dock 未就绪 → 0。 */
export function dockMinimumWidth(api: DockviewApi | null = getDockApi()): number {
  const w = api?.minimumWidth;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * 订阅网格最小宽度:dock api 出现 / 更换、布局变化(组增删 / 移动 / 恢复布局,dockview 合并触发 onDidLayoutChange)、
 * 窗口缩放(组约束可能随之重算)时重读。
 */
export function useDockMinimumWidth(): number {
  const [min, setMin] = useState(() => dockMinimumWidth());
  useEffect(() => {
    let subs: Array<{ dispose(): void }> = [];
    const attach = (api: DockviewApi | null) => {
      for (const s of subs) s.dispose();
      subs = [];
      setMin(dockMinimumWidth(api));
      if (!api) return;
      const read = () => setMin(dockMinimumWidth(api));
      subs = [api.onDidLayoutChange(read), api.onDidAddGroup(read), api.onDidRemoveGroup(read)];
    };
    attach(getDockApi());
    const stop = subscribeDockApi(attach);
    const onResize = () => setMin(dockMinimumWidth());
    window.addEventListener('resize', onResize);
    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      for (const s of subs) s.dispose();
    };
  }, []);
  return min;
}
