// 主窗里某类 dock 面板是否正显示(活动栏「搜索」「运行和调试」图标的激活态;VSCode 活动栏:对应视图在侧栏可见即高亮)。
// 正显示 = 该类型的面板在主窗(不在 popout 子窗)、是其组的活动 tab(dockview isVisible),且没有被别的最大化组遮住。
// 订阅 dock 的面板 / 组 / 布局 / 最大化变化;结构事件可能派发在 location 改完之前 → 延到 microtask 再算(同 main-window-active-panel)。
// BDD: src/__tests__/entry-discoverability/

import { useSyncExternalStore } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { getDockApi, runWhenDockLayoutReady, subscribeDockApi } from './dock-api-ref';
import { onPopoutRestoreSettled } from './popout-restore-settle';

/** 主窗里正显示的该类型面板;没有 → undefined。 */
export function visiblePanelOfType(api: DockviewApi, type: string): IDockviewPanel | undefined {
  const maximized = api.hasMaximizedGroup();
  return api.panels.find(
    (p) =>
      p.view.contentComponent === type &&
      p.api.location.type !== 'popout' &&
      p.api.isVisible &&
      (!maximized || p.group.api.isMaximized()),
  );
}

/** 关掉主窗里正显示的该类型面板(活动栏再点已激活的图标 = 收起,VSCode iconClickBehavior 默认 toggle)。 */
export function closeVisiblePanelOfType(type: string): void {
  runWhenDockLayoutReady((api) => visiblePanelOfType(api, type)?.api.close());
}

function subscribe(listener: () => void): () => void {
  let subs: { dispose(): void }[] = [];
  let current: DockviewApi | null = null;
  const soon = () =>
    queueMicrotask(() => {
      if (current) listener();
    });
  const attach = (api: DockviewApi | null) => {
    for (const sub of subs) sub.dispose();
    current = api;
    subs = api
      ? [
          api.onDidActivePanelChange(listener),
          api.onDidActiveGroupChange(listener),
          api.onDidAddPanel(soon),
          api.onDidRemovePanel(listener),
          api.onDidMovePanel(soon),
          api.onDidAddGroup(soon),
          api.onDidRemoveGroup(soon),
          api.onDidLayoutChange(soon),
          api.onDidLayoutFromJSON(listener),
          api.onDidMaximizedGroupChange(listener),
          { dispose: onPopoutRestoreSettled(() => listener()) },
        ]
      : [];
    listener();
  };
  const stop = subscribeDockApi(attach);
  attach(getDockApi());
  return () => {
    stop();
    for (const sub of subs) sub.dispose();
    subs = [];
    current = null;
  };
}

/** 主窗里该类型面板是否正显示(随 dock 变化重渲)。 */
export function usePanelTypeVisible(type: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      const api = getDockApi();
      return api ? visiblePanelOfType(api, type) !== undefined : false;
    },
    () => false,
  );
}
