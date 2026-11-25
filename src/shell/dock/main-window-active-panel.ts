// 主窗当前活动的 dock 面板(id + 标题),供标题栏 / 状态栏 / 窗口标题。活动的是终端、设置、Debug 等非编辑器面板时,
// 标题显示该面板名,编辑器专属的状态栏项(文件名、行 / 词 / 字符)隐藏 —— 不再显示被挡住的文件(VSCode:编辑区里活动的
// 是终端等非文本编辑器时,窗口标题取其名称,编辑器状态栏项随之隐藏)。
// 活动面板在 popout 子窗时取主窗最近使用的组的活动面板(子窗没有自己的标题栏 / 状态栏)。
// 面板所在窗口变化时 dockview 不保证发活动面板 / 活动组事件:重启恢复的 popout 组在 fromJSON 时已是活动组、子窗 load 后
// 才把 location 改成 popout(无事件)→ 在恢复落定时重算;弹出 / 收回 / 移动面板时组结构事件派发在 location 改完之前 →
// 延到 microtask 再算。
// BDD: src/__tests__/chrome-active-panel/

import { useSyncExternalStore } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { getDockApi, subscribeDockApi } from './dock-api-ref';
import { mainWindowActivePanel } from './group-mru';
import { onPopoutRestoreSettled } from './popout-restore-settle';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';

export interface ActiveDockPanel {
  readonly id: string;
  readonly title: string;
}

interface Disposable {
  dispose(): void;
}

let snapshot: ActiveDockPanel | null = null;
const listeners = new Set<() => void>();
let apiSubs: Disposable[] = [];
let titleSub: Disposable | null = null;
let titlePanel: IDockviewPanel | undefined;
let stopApiWatch: (() => void) | null = null;
let attachedApi: DockviewApi | null = null;

function recompute(api: DockviewApi | null): void {
  const panel = api ? mainWindowActivePanel(api) : undefined;
  if (panel !== titlePanel) {
    titleSub?.dispose();
    titlePanel = panel;
    titleSub = panel ? panel.api.onDidTitleChange(() => recompute(api)) : null;
  }
  const next = panel ? { id: panel.id, title: panel.title ?? '' } : null;
  if (next?.id === snapshot?.id && next?.title === snapshot?.title) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function attach(api: DockviewApi | null): void {
  for (const sub of apiSubs) sub.dispose();
  const recomputeSoon = (): void => queueMicrotask(() => {
    if (attachedApi === api) recompute(api);
  });
  attachedApi = api;
  apiSubs = api
    ? [
        api.onDidActivePanelChange(() => recompute(api)),
        api.onDidActiveGroupChange(() => recompute(api)),
        api.onDidRemovePanel(() => recompute(api)),
        api.onDidLayoutFromJSON(() => recompute(api)),
        api.onDidAddGroup(recomputeSoon),
        api.onDidRemoveGroup(recomputeSoon),
        api.onDidMovePanel(recomputeSoon),
        {
          dispose: onPopoutRestoreSettled((settled) => {
            if (settled === api) recompute(api);
          }),
        },
      ]
    : [];
  recompute(api);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    stopApiWatch = subscribeDockApi(attach);
    attach(getDockApi());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopApiWatch?.();
    stopApiWatch = null;
    for (const sub of apiSubs) sub.dispose();
    apiSubs = [];
    attachedApi = null;
    titleSub?.dispose();
    titleSub = null;
    titlePanel = undefined;
    snapshot = null;
  };
}

const getSnapshot = (): ActiveDockPanel | null => snapshot;

/** 主窗活动的是非编辑器面板时返回该面板;编辑器活动 / 无法判定(dock 未就绪、主窗无面板)→ null(按编辑器显示)。 */
export function useActiveNonEditorPanel(): ActiveDockPanel | null {
  const panel = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // 编辑器面板 = 任一编辑器组(editor / editor:N;BDD: src/__tests__/editor-groups/)
  return panel !== null && !isEditorGroupId(panel.id) ? panel : null;
}
