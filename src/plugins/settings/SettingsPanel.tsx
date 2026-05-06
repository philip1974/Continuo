// 设置 Panel(VSCode 同款 — dockview 工作区里的普通 panel,不再是 Modal)。
// 顶部搜索框 + 左侧 tab 导航 + 右侧内容,h-full 占满 dockview 分配的空间。
// 搜索模式(query 非空)→ 右侧渲染所有命中的 SettingItem 列表,左侧 nav 灰显。
// 普通模式 → 按 active tab 走 spec.render();订阅 SettingTabRegistry +
// SettingItemRegistry,plugin 运行时 register/dispose 自动反映。
//
// BDD: src/__tests__/settings-panel/

import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/design';
import { coApp } from '@/plugins/co-app';
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

interface SettingsPanelProps {
  /** 默认用全局 coApp.settingTabs;测试可注入隔离 registry. */
  readonly registry?: SettingTabRegistry;
  /** 默认用全局 coApp.settingItems;测试可注入隔离 registry. */
  readonly itemRegistry?: SettingItemRegistry;
}

function useTabs(reg: SettingTabRegistry): readonly SettingTabSpec[] {
  const [snapshot, setSnapshot] = useState(() => reg.getAll());
  useEffect(() => reg.subscribe(() => setSnapshot(reg.getAll())), [reg]);
  return snapshot;
}

function useItems(reg: SettingItemRegistry): readonly SettingItemSpec[] {
  const [snapshot, setSnapshot] = useState(() => reg.getAll());
  useEffect(() => reg.subscribe(() => setSnapshot(reg.getAll())), [reg]);
  return snapshot;
}

function matchSearch(item: SettingItemSpec, q: string): boolean {
  const ql = q.toLowerCase();
  if (item.title.toLowerCase().includes(ql)) return true;
  if (item.id.toLowerCase().includes(ql)) return true;
  if (item.description && item.description.toLowerCase().includes(ql)) {
    return true;
  }
  return false;
}

export function SettingsPanel({
  registry = coApp.settingTabs,
  itemRegistry = coApp.settingItems,
}: SettingsPanelProps = {}) {
  const activeTabId = useSettingsStore((s) => s.activeTabId);
  const setActiveTabId = useSettingsStore((s) => s.setActiveTabId);
  const tabs = useTabs(registry);
  const allItems = useItems(itemRegistry);
  // active 兜底:未选 / id 已被 dispose → 取首项
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const matched = useMemo(() => {
    if (!trimmed) return null; // null = 不在搜索模式
    return allItems.filter((item) => matchSearch(item, trimmed));
  }, [trimmed, allItems]);
  const inSearch = matched !== null;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="border-b border-line bg-panel-soft/50 p-3">
        <Input
          size="sm"
          placeholder="搜索设置(标题 / 描述 / id)…"
          value={query}
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          // 改 search 时回到搜索结果区,避免左侧 nav 视觉错位
          autoFocus
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          className={[
            'w-[200px] shrink-0 overflow-y-auto border-r border-line bg-panel-soft py-2 text-xs transition-opacity',
            inSearch ? 'pointer-events-none opacity-40' : 'opacity-100',
          ].join(' ')}
          aria-label="设置分类"
        >
          {tabs.length === 0 ? (
            <div className="px-3 py-4 text-fg-dim">暂无设置项</div>
          ) : (
            tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTabId(t.id)}
                className={[
                  'flex w-full items-center px-3 py-2 text-left transition',
                  active?.id === t.id
                    ? 'bg-hover text-fg'
                    : 'text-fg-muted hover:bg-hover/50',
                ].join(' ')}
              >
                {t.title}
              </button>
            ))
          )}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6 text-xs text-fg-muted">
          {inSearch ? (
            <div>
              <div className="mb-3 text-fg-dim">
                {matched!.length === 0
                  ? `未找到匹配「${trimmed}」的设置项`
                  : `匹配 ${matched!.length} 项「${trimmed}」`}
              </div>
              <div className="flex flex-col">
                {matched!.map((spec) => (
                  <SettingItemRow key={spec.id} spec={spec} />
                ))}
              </div>
            </div>
          ) : active ? (
            active.render()
          ) : null}
        </div>
      </div>
    </div>
  );
}
