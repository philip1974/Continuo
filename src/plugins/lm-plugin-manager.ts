// 用户插件 PluginManager 单例(M-Plugin v4.1)。
// main.tsx 在 bootCorePlugins 后实例化并 init();其它地方通过 getter 访问
// 当前快照(用于 Plugins SettingTab 等 UI)。

import { PluginManager } from './PluginManager';

let _manager: PluginManager | null = null;

export function setUserPluginManager(m: PluginManager): void {
  _manager = m;
}

export function getUserPluginManager(): PluginManager | null {
  return _manager;
}
