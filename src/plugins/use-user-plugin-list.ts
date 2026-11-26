import { useMemo, useSyncExternalStore } from 'react';
import { getUserPluginManager, type PluginListItem } from './PluginManager';

const EMPTY_USER_PLUGIN_LIST: readonly PluginListItem[] = [];
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** user plugin manager 的已发现插件列表;manager 不存在(popout 窗口 / 尚未初始化)时为稳定空列表。 */
function readUserPluginList(): readonly PluginListItem[] {
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

/**
 * 面向用户称呼插件用的名称(用户认得的是名称;对齐 VSCode 扩展视图以 displayName 为标题、id 作副文本):manifest.name,
 * 列表里查不到(尚未登记)退回 id。插件提供的原文 —— 授权类弹窗里须经 UntrustedText 显示。
 */
export function usePluginDisplayName(pluginId: string): string {
  const plugins = useUserPluginList();
  return plugins.find((p) => p.id === pluginId)?.manifest.name ?? pluginId;
}

/**
 * 插件 id → manifest.name 的查询函数(设置页按插件分节 / 搜索分组标题用);列表里查不到 → undefined(调用方退回 id)。
 * 列表不变时返回同一函数(可作 memo 依赖)。
 */
export function usePluginNameOf(): (pluginId: string) => string | undefined {
  const plugins = useUserPluginList();
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const p of plugins) names.set(p.id, p.manifest.name);
    return (id: string) => names.get(id);
  }, [plugins]);
}
