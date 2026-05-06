// 模块级单例:暴露 DockviewApi 给 Dockview 之外的组件(IconSidebar 等)。
// DockShell.onReady 时 setDockApi(event.api),unmount 时 setDockApi(null)。
//
// 用法:focusPanel('explorer') 切到对应 panel(若不存在不报错)。

import type { DockviewApi } from 'dockview-react';

let apiRef: DockviewApi | null = null;

export function setDockApi(api: DockviewApi | null): void {
  apiRef = api;
}

export function getDockApi(): DockviewApi | null {
  return apiRef;
}

export function focusPanel(panelId: string): void {
  const api = apiRef;
  if (!api) return;
  const panel = api.getPanel(panelId);
  if (panel) panel.api.setActive();
}

/**
 * 单例 panel 打开/聚焦(VSCode Settings 风格):
 * - 已存在同 id panel → setActive,不重建
 * - 不存在 → addPanel({ id, component, title })
 *
 * dock 未就绪 → 静默忽略(开机时序保护)。
 */
export function openOrFocusPanel(
  id: string,
  component: string,
  title: string,
): void {
  const api = apiRef;
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({ id, component, title });
}
