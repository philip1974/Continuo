// 设置 Panel(VSCode 同款 — dockview 工作区里的普通 panel,不再是 Modal)。
// 顶部搜索框 + 左侧 tab 导航 + 右侧内容,h-full 占满 dockview 分配的空间。
// 搜索模式(query 非空)→ 右侧渲染所有命中的 SettingItem 列表,左侧 nav 灰显。
// 普通模式 → 按 active tab 走 spec.render();订阅 SettingTabRegistry +
// SettingItemRegistry,plugin 运行时 register/dispose 自动反映。
//
// BDD: src/__tests__/settings-panel/

import { useMemo, useState } from 'react';
import { Input } from '@/design';
import { coApp } from '@/plugins/co-app';
import { useRegistry } from '../registries/useRegistry';
import type {
  SettingItemRegistry,
  SettingItemSpec,
} from '../registries/SettingItemRegistry';
import type {
  SettingTabRegistry,
  SettingTabSpec,
} from '../registries/SettingTabRegistry';
import { SettingItemRow } from './SettingItemRow';
import { useSettingsStore } from './store';
import { useT, useLocale, tWithFallback } from '@/i18n';

interface SettingsPanelProps {
  /** 默认用全局 coApp.settingTabs;测试可注入隔离 registry. */
  readonly registry?: SettingTabRegistry;
  /** 默认用全局 coApp.settingItems;测试可注入隔离 registry. */
  readonly itemRegistry?: SettingItemRegistry;
}

function useTabs(reg: SettingTabRegistry): readonly SettingTabSpec[] {
  return useRegistry(reg);
}

function useItems(reg: SettingItemRegistry): readonly SettingItemSpec[] {
  return useRegistry(reg);
}

/** 一条设置项的搜索源:本地化标题/描述 + id + raw fallback,全 lowercase. */
interface SearchableItem {
  readonly item: SettingItemSpec;
  readonly haystack: string;
}

// 内置 4 类 category → catalog tab_title key 映射；plugin 自定义 category fallback raw 字符串
const CATEGORY_TITLE_KEYS: Record<string, string> = {
  general: 'settings.general.tab_title',
  editor: 'settings.editor.tab_title',
  explorer: 'settings.explorer.tab_title',
  terminal: 'settings.terminal.tab_title',
};

interface SearchBucket {
  readonly category: string;
  readonly label: string;
  readonly items: readonly SettingItemSpec[];
}

/** 把搜索结果按 category 分组，label 走 i18n catalog（topic-20）。 */
function groupSearchResults(
  items: readonly SettingItemSpec[],
): readonly SearchBucket[] {
  const map = new Map<string, SettingItemSpec[]>();
  for (const spec of items) {
    let arr = map.get(spec.category);
    if (!arr) {
      arr = [];
      map.set(spec.category, arr);
    }
    arr.push(spec);
  }
  return Array.from(map.entries()).map(([category, items]) => ({
    category,
    label: tWithFallback(CATEGORY_TITLE_KEYS[category], category),
    items,
  }));
}

export function SettingsPanel({
  registry = coApp.settingTabs,
  itemRegistry = coApp.settingItems,
}: SettingsPanelProps = {}) {
  const t = useT();
  const activeTabId = useSettingsStore((s) => s.activeTabId);
  const setActiveTabId = useSettingsStore((s) => s.setActiveTabId);
  const tabs = useTabs(registry);
  // active 兜底:未选 / id 已被 dispose → 取首项
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  // 搜索模式仅由 query 判定(打磨 R49):普通浏览设置 tab 时不订阅 itemRegistry、
  // 不构建搜索 haystack —— 这些都搬进仅搜索模式才挂载的 SettingsSearchResults。
  const inSearch = trimmed.length > 0;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="border-b border-line bg-panel-soft/50 p-3">
        <Input
          size="sm"
          placeholder={t('settings.panel.search_placeholder')}
          value={query}
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          // 改 search 时回到搜索结果区,避免左侧 nav 视觉错位
          autoFocus
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          className={[
            'flex w-[180px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel-soft py-2 text-xs transition-opacity',
            inSearch ? 'pointer-events-none opacity-40' : 'opacity-100',
          ].join(' ')}
          aria-label={t('settings.panel.nav_aria')}
        >
          {tabs.length === 0 ? (
            <div className="px-4 py-4 text-fg-dim">{t('settings.panel.no_items')}</div>
          ) : (
            tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTabId(tab.id)}
                className={[
                  'flex w-full items-center gap-2 border-l-2 px-4 py-2 text-left transition',
                  active?.id === tab.id
                    ? 'border-accent bg-hover text-fg'
                    : 'border-transparent text-fg-muted hover:bg-hover/50',
                ].join(' ')}
              >
                {tab.icon && (
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                    {tab.icon}
                  </span>
                )}
                <span className="truncate">
                  {tWithFallback(tab.titleKey, tab.title)}
                </span>
              </button>
            ))
          )}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6 text-xs text-fg-muted">
          {inSearch ? (
            <SettingsSearchResults itemRegistry={itemRegistry} trimmed={trimmed} />
          ) : active ? (
            active.render()
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 搜索结果区(打磨 R49):仅在搜索模式(query 非空)时挂载。订阅 itemRegistry +
 * 构建本地化 haystack + 过滤分组都在这里 —— 普通浏览设置 tab 时父组件不挂载本
 * 组件,故不订阅 itemRegistry、不跑这些派生(插件注册 item / 切语言时不触发)。
 */
function SettingsSearchResults({
  itemRegistry,
  trimmed,
}: {
  readonly itemRegistry: SettingItemRegistry;
  readonly trimmed: string;
}) {
  const t = useT();
  // locale 值随语言切换变化(useTWithFallback 返回的函数 identity 稳定,不能当
  // memo deps),驱动本地化 haystack 切语言重算(打磨 R30)。
  const locale = useLocale();
  const allItems = useItems(itemRegistry);
  // 预计算本地化 haystack:搜索源用 titleKey/descriptionKey 翻译后的可见文案
  // (SettingItemRow 实际显示的),否则中文/韩文下按屏幕文字搜不到。保留 id + raw
  // title/description 作补充。deps 含 locale 切语言重算。
  const searchable = useMemo<readonly SearchableItem[]>(
    () =>
      allItems.map((item) => ({
        item,
        haystack: [
          tWithFallback(item.titleKey, item.title),
          tWithFallback(item.descriptionKey, item.description ?? ''),
          item.id,
          item.title,
          item.description ?? '',
        ]
          .join(' ')
          .toLowerCase(),
      })),
    // locale 作失效键:tWithFallback 内部按当前 locale 翻译,lint 看不到该依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allItems, locale],
  );
  const matched = useMemo(() => {
    const ql = trimmed.toLowerCase();
    return searchable.filter((s) => s.haystack.includes(ql)).map((s) => s.item);
  }, [trimmed, searchable]);
  const matchedBuckets = useMemo(() => groupSearchResults(matched), [matched]);

  return (
    <div>
      <div className="mb-3 text-fg-dim">
        {matched.length === 0
          ? t('settings.panel.no_match', { q: trimmed })
          : t('settings.panel.matched', { count: matched.length, q: trimmed })}
      </div>
      {matchedBuckets.map((bucket) => (
        <section
          key={bucket.category}
          className="first:mt-0 [&:not(:first-child)]:mt-10"
        >
          <h3 className="mb-3 border-b border-line pb-3 text-base font-medium text-fg">
            {bucket.label}
          </h3>
          {bucket.items.map((spec) => (
            <SettingItemRow key={spec.id} spec={spec} />
          ))}
        </section>
      ))}
    </div>
  );
}
