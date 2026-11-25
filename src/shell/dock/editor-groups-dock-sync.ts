// 编辑器组 ↔ dock 面板的双向同步(组 id = editor 面板 id;BDD: src/__tests__/editor-groups/):
// - store 里组被关闭(组内最后一个 tab 关掉 / 删除文件致空 / 恢复时丢弃)→ 关闭对应 dock 面板;
// - dock 面板被关掉(dock tab × / 组整体关闭;移动到别的组 / popout 不算)→ 移除该组(其干净文档关闭、脏文档移到相邻组;
//   唯一的组不移除,与历史一致);
// - dock 激活某个编辑器组面板 → 它成为活动编辑器组(打开文件落在这里)。
// 启动恢复结束后 reconcileEditorGroupsWithDock 对齐两边(没有面板的组并入有面板的组,没有文档的多余组面板关闭)。

import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { editorGroupIdsOf, editorGroupsOf, groupTabMruOf, useEditorStore } from '@/stores/editor.store';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import { getDockApi, runWhenDockLayoutReady, subscribeDockApi } from './dock-api-ref';

const EDITOR_PANEL_TYPE = 'editor';

function isEditorGroupPanel(panel: Pick<IDockviewPanel, 'id' | 'view'>): boolean {
  return isEditorGroupId(panel.id) && panel.view?.contentComponent === EDITOR_PANEL_TYPE;
}

function closePanel(panel: IDockviewPanel): void {
  try {
    panel.api.close();
  } catch {
    /* 已被其它路径移除 */
  }
}

export function trackEditorGroups(api: DockviewApi): { dispose: () => void } {
  const unsubscribe = useEditorStore.subscribe((s, prev) => {
    if (s.groups === prev.groups) return;
    const now = new Set(editorGroupIdsOf(s));
    for (const id of editorGroupIdsOf(prev)) {
      if (now.has(id)) continue;
      const panel = api.getPanel(id);
      if (panel && isEditorGroupPanel(panel)) closePanel(panel);
    }
  });
  const subs = [
    api.onDidRemovePanel((panel) => {
      if (!isEditorGroupPanel(panel)) return;
      const id = panel.id;
      // 移到别的 dock 组 / 弹出 / 收回:dockview 先移除再加入,微任务后仍在 → 不是关闭
      queueMicrotask(() => {
        if (api.getPanel(id)) return;
        useEditorStore.getState().removeGroup(id, 'dirty');
      });
    }),
    api.onDidActivePanelChange((panel) => {
      if (panel && isEditorGroupPanel(panel)) useEditorStore.getState().setActiveGroup(panel.id);
    }),
  ];
  return {
    dispose: () => {
      unsubscribe();
      for (const sub of subs) sub.dispose();
    },
  };
}

/**
 * 启动恢复(dock 布局 + 编辑器会话)结束后对齐组与面板:
 * - 没有面板的组:有空着的(不属于任何组的)编辑器面板 → 组搬到那个面板;否则文档并入活动组(不丢);
 * - 没有文档的组(恢复占位 / 会话里读盘失败)丢弃,其面板随之关闭;
 * - 不属于任何组的多余编辑器面板关闭(至少留一个编辑器面板)。
 */
export function reconcileEditorGroupsWithDock(api: DockviewApi): void {
  const s = useEditorStore.getState();
  const groups = editorGroupsOf(s);
  const panelIds = api.panels.filter(isEditorGroupPanel).map((p) => p.id);
  const groupIds = new Set(groups.map((g) => g.id));
  const orphanPanels = panelIds.filter((id) => !groupIds.has(id));
  if (s.tabs.length > 0 && (groups.length > 1 || orphanPanels.length > 0 || !panelIds.includes(groups[0]!.id))) {
    const rename = new Map<string, string>();
    for (const g of groups) {
      if (panelIds.includes(g.id)) continue;
      const home = orphanPanels.shift();
      if (home !== undefined) rename.set(g.id, home);
    }
    const layout = groups
      .filter((g) => rename.has(g.id) || panelIds.includes(g.id))
      .map((g) => ({ id: rename.get(g.id) ?? g.id, tabIds: g.tabIds, activeTabId: g.activeTabId, mru: groupTabMruOf(s, g.id) }));
    const active = rename.get(s.activeGroupId) ?? (panelIds.includes(s.activeGroupId) ? s.activeGroupId : layout[0]?.id);
    if (active !== undefined) s.restoreGroups(layout, active);
    else if (groups.length > 1) {
      // 一个编辑器面板都没有(用户关掉了):全部并入活动组,打开文件时按它补建面板(与单组时一致)
      const g = groups.find((x) => x.id === s.activeGroupId) ?? groups[0]!;
      s.restoreGroups([{ id: g.id, tabIds: g.tabIds, activeTabId: g.activeTabId, mru: groupTabMruOf(s, g.id) }], g.id);
    }
  }
  const live = new Set(editorGroupIdsOf(useEditorStore.getState()));
  let count = api.panels.filter(isEditorGroupPanel).length;
  for (const panel of api.panels.filter(isEditorGroupPanel)) {
    if (count <= 1) break;
    if (live.has(panel.id)) continue;
    closePanel(panel);
    count -= 1;
  }
}

/** 启动恢复结束后调用:等 dock 出现并恢复布局后对齐一次(dock 尚未 onReady 时等它出现)。 */
export function reconcileEditorGroupsAfterRestore(): void {
  if (getDockApi()) {
    runWhenDockLayoutReady(reconcileEditorGroupsWithDock);
    return;
  }
  const stop = subscribeDockApi((api) => {
    if (!api) return;
    stop();
    runWhenDockLayoutReady(reconcileEditorGroupsWithDock);
  });
}
