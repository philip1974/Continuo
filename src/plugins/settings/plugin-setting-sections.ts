// 设置项所属「节」(BDD: src/__tests__/plugin-settings-section/)。
// 内置 category 各有页签;插件用其它 category 注册的项归「插件设置」页签,按插件分节(对齐 VSCode 设置编辑器的
//「扩展 › <扩展名>」节点)。搜索结果分组与「插件设置」页签共用这里的节划分与可读名。

import { tWithFallback } from '@/i18n';
import { ownValue } from '../../../electron/shared/own-value';
import type { SettingItemSpec } from '../registries/SettingItemRegistry';
import { contributionPluginId } from '../scoped-app';

/** 内置 category → 对应页签标题 key(这些 category 由各内置页签的 CategoryTabContent 渲染)。 */
const BUILTIN_CATEGORY_TITLE_KEYS: Record<string, string> = {
  general: 'settings.general.tab_title',
  editor: 'settings.editor.tab_title',
  explorer: 'settings.explorer.tab_title',
  terminal: 'settings.terminal.tab_title',
};

export const PLUGIN_SETTINGS_TAB_ID = 'core.plugin-settings';

/** 该项不属于任何内置页签 → 归「插件设置」页签。 */
export function isPluginSettingItem(item: SettingItemSpec): boolean {
  return ownValue(BUILTIN_CATEGORY_TITLE_KEYS, item.category) === undefined;
}

export interface SettingSection {
  /** 分组身份:内置 category 原文;插件项 `plugin:<id>`;无所有者记录的项 `category:<category>`。 */
  readonly key: string;
  readonly label: string;
}

/** 插件 id → 面向用户的名称(manifest.name);查不到返回 undefined(退回 id)。 */
export type PluginNameOf = (pluginId: string) => string | undefined;

export function settingSectionOf(item: SettingItemSpec, nameOf: PluginNameOf): SettingSection {
  const titleKey = ownValue(BUILTIN_CATEGORY_TITLE_KEYS, item.category);
  if (titleKey !== undefined) return { key: item.category, label: tWithFallback(titleKey, item.category) };
  const pluginId = contributionPluginId(item);
  if (pluginId === null) return { key: `category:${item.category}`, label: item.category };
  return { key: `plugin:${pluginId}`, label: nameOf(pluginId) ?? pluginId };
}
