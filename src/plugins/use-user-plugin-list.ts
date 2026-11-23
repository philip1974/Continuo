import { useSyncExternalStore } from 'react';
import { getUserPluginManager, type PluginListItem } from './PluginManager';

const EMPTY_USER_PLUGIN_LIST: readonly PluginListItem[] = [];
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** user plugin manager 的已发现插件列表;manager 不存在(popout 窗口 / 尚未初始化)时为稳定空列表。 */
export function readUserPluginList(): readonly PluginListItem[] {
  const m = getUserPluginManager();
  return m ? m.listAll() : EMPTY_USER_PLUGIN_LIST;
}

/**
 * 订阅 user plugin manager 的插件列表:manager 在列表每次变化时通知(含 init 异步完成后的迟到入表),
 * listAll 在两次变化之间返回同一引用,所以无变化不重渲。
 */
export function useUserPluginList(): readonly PluginListItem[] {
  const m = getUserPluginManager();
  return useSyncExternalStore(m ? m.subscribe : NOOP_SUBSCRIBE, readUserPluginList);
}
