// main 推送的插件事件 → 本窗口 PluginManager(main-app 接线,BDD: plugin-reload-gate)。
// - plugins.onChanged(mtime watch)→ reload(M-Plugin v4.3.1 热重载)
// - plugins.onUninstalled(终审 P1:跨窗口卸载)→ handleUninstalled
// - plugins.onEnabledChanged(终审 P1:跨窗口启停)→ handleEnabledChanged
// 启动期门控(R16)在 PluginManager 内:扫描完成前到达的事件等条目登记后再处理,不等全部插件激活完;
// 禁用 / 卸载 / 启用的同步部分(吊销、取消授权弹窗、清停用意图)在各方法开头立即执行。
// 调用方须先发起 init()。处理失败只交给 onError,不抛。

import type { PluginManager } from './PluginManager';
import { clearPendingInstall } from './pending-installs-store';

export interface PluginEventSources {
  readonly onChanged: (cb: (id: string) => void) => void;
  readonly onUninstalled: (cb: (id: string) => void) => void;
  readonly onEnabledChanged: (cb: (id: string, enabled: boolean) => void) => void;
}

export type PluginEventKind = 'reload' | 'uninstalled' | 'enabled-changed';

export function wirePluginEvents(
  mgr: Pick<PluginManager, 'reload' | 'handleUninstalled' | 'handleEnabledChanged'>,
  sources: PluginEventSources,
  onError: (where: PluginEventKind, err: unknown) => void,
): void {
  sources.onChanged((id) => {
    void mgr.reload(id).catch((err) => onError('reload', err));
  });
  sources.onUninstalled((id) => {
    // 别的窗口卸载了本窗口记为「已安装、待重启」的插件(本窗口列表里没有它,handleUninstalled 不会通知列表订阅者,
    // 落地摘除也就不会跑)→ 同步清掉记录,否则市场卡片 / 设置页留下幽灵待重启行。
    clearPendingInstall(id);
    void mgr.handleUninstalled(id).catch((err) => onError('uninstalled', err));
  });
  sources.onEnabledChanged((id, enabled) => {
    void mgr.handleEnabledChanged(id, enabled).catch((err) => onError('enabled-changed', err));
  });
}
