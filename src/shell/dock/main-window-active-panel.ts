// 主窗当前活动的 dock 面板(id + 标题),供标题栏 / 状态栏 / 窗口标题。活动的是终端、设置、Debug 等非编辑器面板时,
// 标题显示该面板名,编辑器专属的状态栏项(文件名、行 / 词 / 字符)隐藏 —— 不再显示被挡住的文件(VSCode:编辑区里活动的
// 是终端等非文本编辑器时,窗口标题取其名称,编辑器状态栏项随之隐藏)。
// 活动面板在 popout 子窗时取主窗最近使用的组的活动面板(子窗没有自己的标题栏 / 状态栏)。
// BDD: src/__tests__/chrome-active-panel/

import { useSyncExternalStore } from 'react';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { getDockApi, subscribeDockApi } from './dock-api-ref';
import { mostRecentMainWindowPanel } from './group-mru';

export interface ActiveDockPanel {
  readonly id: string;
  readonly title: string;
}

interface Disposable {
  dispose(): void;
}

/** 编辑器面板(所有文件 tab 都在它里面)。 */
const EDITOR_PANEL_ID = 'editor';

let snapshot: ActiveDockPanel | null = null;
const listeners = new Set<() => void>();
let apiSubs: Disposable[] = [];
let titleSub: Disposable | null = null;
let titlePanel: IDockviewPanel | undefined;
let stopApiWatch: (() => void) | null = null;

function mainWindowActivePanel(api: DockviewApi): IDockviewPanel | undefined {
  const panel = api.activePanel;
  return panel?.api.location.type === 'popout' ? mostRecentMainWindowPanel(api) : panel;
}

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
  apiSubs = api
    ? [
        api.onDidActivePanelChange(() => recompute(api)),
        api.onDidActiveGroupChange(() => recompute(api)),
        api.onDidRemovePanel(() => recompute(api)),
        api.onDidLayoutFromJSON(() => recompute(api)),
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
  return panel !== null && panel.id !== EDITOR_PANEL_ID ? panel : null;
}
