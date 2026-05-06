// 设置 Panel(VSCode 同款 — dockview 工作区里的普通 panel,不再是 Modal)。
// 左侧 tab 导航 + 右侧内容,h-full 占满 dockview 分配的空间。
// 订阅 SettingTabRegistry,plugin 运行时 register/dispose 自动反映。
//
// BDD: src/__tests__/settings-panel/

import { useEffect, useState } from 'react';
import { coApp } from '@/plugins/co-app';
import type {
  SettingTabRegistry,
  SettingTabSpec,
} from '../registries/SettingTabRegistry';
import { useSettingsStore } from './store';

interface SettingsPanelProps {
  /** 默认用全局 coApp.settingTabs;测试可注入隔离 registry. */
  readonly registry?: SettingTabRegistry;
}

function useTabs(reg: SettingTabRegistry): readonly SettingTabSpec[] {
  const [snapshot, setSnapshot] = useState(() => reg.getAll());
  useEffect(() => reg.subscribe(() => setSnapshot(reg.getAll())), [reg]);
  return snapshot;
}

export function SettingsPanel({
  registry = coApp.settingTabs,
}: SettingsPanelProps = {}) {
  const activeTabId = useSettingsStore((s) => s.activeTabId);
  const setActiveTabId = useSettingsStore((s) => s.setActiveTabId);
  const tabs = useTabs(registry);
  // active 兜底:未选 / id 已被 dispose → 取首项
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  return (
    <div className="flex h-full bg-canvas">
      <nav
        className="w-[200px] shrink-0 overflow-y-auto border-r border-line bg-panel-soft py-2 text-xs"
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
        {active ? active.render() : null}
      </div>
    </div>
  );
}
