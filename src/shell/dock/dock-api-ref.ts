// 模块级单例:暴露 DockviewApi 给 Dockview 之外的组件(IconSidebar 等)。
// DockShell.onReady 时 setDockApi(event.api),unmount 时 setDockApi(null)。
//
// 用法:focusPanel('explorer') 切到对应 panel(若不存在不报错)。

import type { DockviewApi } from 'dockview-react';
import { cancelPendingPanelClose } from './wrap-panel-close';

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
  if (panel) {
    // 面板可能正处于关闭 EXIT 动画窗口内(刚关随即又聚焦)。撤销排定的真 close,
    // 否则刚激活的面板会在 EXIT_DURATION_MS 后随排定 close 一起消失。镜像
    // DockShell editor 激活路径;该守卫此前只在 DockShell 一处,漏了 dock-api-ref。
    cancelPendingPanelClose(panelId);
    panel.api.setActive();
  }
}

/**
 * 单例 panel 打开/聚焦(VSCode Settings 风格):
 * - 已存在同 id panel → setActive,不重建
 * - 不存在 → addPanel({ id, component, title, params: { titleKey } })
 *
 * dock 未就绪 → 静默忽略(开机时序保护)。
 */
export function openOrFocusPanel(
  id: string,
  component: string,
  title: string,
  titleKey?: string,
): void {
  const api = apiRef;
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    // 同上:撤销排定中的真 close,否则刚聚焦的单例面板(Settings 等)会在
    // EXIT_DURATION_MS 后凭空消失。镜像 DockShell editor 路径与 focusPanel。
    cancelPendingPanelClose(id);
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id,
    component,
    title,
    ...(titleKey ? { params: { titleKey } } : {}),
  });
}
