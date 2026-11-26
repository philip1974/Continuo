// 模块级单例:暴露 DockviewApi 给 Dockview 之外的组件(IconSidebar 等)。
// DockShell.onReady 时 setDockApi(event.api),unmount 时 setDockApi(null)。
//
// 用法:focusPanel('editor') 切到对应 panel(若不存在不报错)。

import type { AddPanelOptions, DockviewApi, IDockviewPanel } from 'dockview-react';
import { activateDockPanel } from './wrap-panel-close';
import { mainWindowAddPosition } from './group-mru';
import { focusPanelContentWhenReady } from './panel-focus';
import { focusMainWindowFromPopout } from './main-window-focus';
import { notifyThrownError } from '@/notifications/notify-thrown-error';

let apiRef: DockviewApi | null = null;
// race:DockShell 在 onReady 入口就暴露 api,但随后 await layout.read() 才 fromJSON(dockview 内部先
// clear())。恢复前经 openOrFocusPanel addPanel 的面板会被清掉且不再补建 → 布局恢复前排队,
// markDockLayoutRestored 后按序执行。队列项是执行时求值的回调(拿恢复后的 api 再按实际面板状态决策)。
let layoutRestored = true;
let queuedOpens: Array<(api: DockviewApi) => void> = [];
const apiListeners = new Set<(api: DockviewApi | null) => void>();

/** 订阅 dock api 的出现 / 更换 / 卸载(dock 外的组件据此订阅 dockview 事件);返回退订函数。 */
export function subscribeDockApi(listener: (api: DockviewApi | null) => void): () => void {
  apiListeners.add(listener);
  return () => {
    apiListeners.delete(listener);
  };
}

/**
 * @param opts.layoutPending true = 该 api 的布局尚未恢复(DockShell onReady),addPanel 类入口排队,
 *   直到 markDockLayoutRestored(api)。缺省视为已就绪(既有调用方行为不变)。
 */
export function setDockApi(
  api: DockviewApi | null,
  opts?: { layoutPending?: boolean },
): void {
  apiRef = api;
  layoutRestored = !(api && opts?.layoutPending === true);
  // race:onReady 重入(dockview 重建 / StrictMode / HMR)时新 api 仍待恢复 → 已排队的用户操作按序迁移给它
  //(回调执行时才取 api,迁移即生效),不丢弃;卸载(null)或新 api 无需等待恢复 → 丢弃。
  if (layoutRestored) queuedOpens = [];
  for (const listener of apiListeners) listener(api);
}

/** 布局(fromJSON / 默认布局)恢复完成:放行并执行恢复前排队的 addPanel 入口。 */
export function markDockLayoutRestored(api: DockviewApi): void {
  if (apiRef !== api) return; // 过期 api(onReady 重入 / 已卸载)
  layoutRestored = true;
  const queued = queuedOpens;
  queuedOpens = [];
  for (const run of queued) {
    try {
      run(api);
    } catch (err) {
      // 直接调用失败时调用方有错误反馈;排队重放已脱离调用栈 → 统一可见通知,不静默吞掉。
      console.warn('[dock] queued dock operation failed after layout restore', err);
      notifyThrownError(err);
    }
  }
}

/**
 * 在布局就绪后以当前 api 执行 fn:已就绪 → 立即执行;布局待恢复 → 排队到 markDockLayoutRestored
 * (与 openOrFocusPanel 同一队列、同一顺序);dock 未就绪 → 静默忽略。
 * fn 在执行时求值,须按届时的实际面板状态决策(如 Settings toggle)。
 */
export function runWhenDockLayoutReady(fn: (api: DockviewApi) => void): void {
  const api = apiRef;
  if (!api) return;
  if (!layoutRestored) {
    queuedOpens.push(fn);
    return;
  }
  fn(api);
}

export function getDockApi(): DockviewApi | null {
  return apiRef;
}

export function focusPanel(panelId: string): void {
  const api = apiRef;
  if (!api) return;
  const panel = api.getPanel(panelId);
  if (panel) activateDockPanel(panel);
}

/**
 * 单例 panel 打开/聚焦(VSCode Settings 风格):
 * - 已存在同 id panel → 在其所在窗口激活(在 popout 子窗 → 另聚焦该子窗与面板内容),不重建
 * - 不存在 → addPanel({ id, component, title, params: { titleKey } }),落点见 openOrFocusPanelNow
 *
 * dock 未就绪 → 静默忽略(开机时序保护);api 已有但布局尚未恢复 → 排队到恢复完成后执行。
 */
export function openOrFocusPanel(
  id: string,
  component: string,
  title: string,
  titleKey?: string,
): void {
  runWhenDockLayoutReady((api) => {
    openOrFocusPanelNow(api, id, component, title, titleKey);
  });
}

/**
 * 用户入口激活一个已存在的面板,并让它出现在用户眼前、接过键盘焦点:在 popout 子窗里 → 先聚焦子窗(dockview 只在活动组
 * 变化时 focus 子窗,子窗组本就是活动组时不会);随后把焦点交给面板内容(⌘, 重新激活后台 tab 里的设置 → 搜索框)。
 * VSCode:openView(id, focus=true) / 打开已在辅助窗口里的编辑器 → 在其所在窗口激活并聚焦。BDD: src/__tests__/open-panel-focus/
 */
export function revealDockPanel(api: Pick<DockviewApi, 'activePanel'>, panel: IDockviewPanel): void {
  activateDockPanel(panel);
  const location = panel.api.location;
  if (location?.type === 'popout') location.getWindow().focus();
  // 在主窗而系统焦点在某个 popout 子窗(从子窗触发 ⌘, / ⇧⌘F…)→ 激活主窗(VSCode 同,见 main-window-focus)
  else focusMainWindowFromPopout();
  focusPanelContentWhenReady(panel, () => api.activePanel === panel);
}

/**
 * 用户入口新建面板并让它接过键盘焦点(内容挂载后,见 focusPanelContentWhenReady);返回新面板。
 * 只给用户发起的入口(⌘, / ⇧⌘F / dock「⋯」/ 查看:显示输出 / 插件 app.dock.openPanel)—— 后台 / agent 建面板
 *(DockReconciler 建终端、会话恢复)直接 api.addPanel,不抢焦点。BDD: src/__tests__/open-panel-focus/
 */
export function addPanelAndFocus(
  api: Pick<DockviewApi, 'addPanel' | 'activePanel'>,
  options: AddPanelOptions,
): IDockviewPanel {
  const panel = api.addPanel(options);
  // 落在主窗而系统焦点在某个 popout 子窗 → 激活主窗;落在子窗(子窗「⋯」菜单新建)→ 焦点本就在那边
  if (panel.api.location?.type !== 'popout') focusMainWindowFromPopout();
  focusPanelContentWhenReady(panel, () => api.activePanel === panel);
  return panel;
}

/**
 * openOrFocusPanel 的同步版本:直接作用于给定 api,不排队。供已持有 api、布局已恢复的入口
 *(Dock「⋯」菜单打开单例面板)复用;`position` 指定新建时落在哪(如菜单所在 group)。
 * 未指定 position = 主窗入口(齿轮 / 菜单 / 命令 / 快捷键 / 插件 app.dock.openPanel):活动组在 popout 子窗时改投主窗
 *(mainWindowAddPosition),不落进用户看不到的子窗。BDD: src/__tests__/popout-open-target/
 */
export function openOrFocusPanelNow(
  api: DockviewApi,
  id: string,
  component: string,
  title: string,
  titleKey?: string,
  position?: AddPanelOptions['position'],
): void {
  const existing = api.getPanel(id);
  if (existing) {
    revealDockPanel(api, existing);
    return;
  }
  const target = position ?? mainWindowAddPosition(api);
  addPanelAndFocus(api, {
    id,
    component,
    title,
    ...(target ? { position: target } : {}),
    ...(titleKey ? { params: { titleKey } } : {}),
  });
}
