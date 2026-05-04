// 设置弹窗(M-Plugin v2.4)。
// 左侧 tab 列表,右侧内容;订阅 SettingTabRegistry 动态渲染。
// 无任何 tab 注册时显示空态文案。

import { useEffect, useState } from 'react';
import { Modal } from '@/design';
import type {
  SettingTabRegistry,
  SettingTabSpec,
} from '../registries/SettingTabRegistry';
import { useSettingsStore } from './store';

interface SettingsModalProps {
  readonly settingTabs: SettingTabRegistry;
}

function useTabs(reg: SettingTabRegistry): readonly SettingTabSpec[] {
  const [snapshot, setSnapshot] = useState(() => reg.getAll());
  useEffect(() => reg.subscribe(() => setSnapshot(reg.getAll())), [reg]);
  return snapshot;
}

export function SettingsModal({ settingTabs }: SettingsModalProps) {
  const isOpen = useSettingsStore((s) => s.isOpen);
  const activeTabId = useSettingsStore((s) => s.activeTabId);
  const close = useSettingsStore((s) => s.close);
  const setActiveTabId = useSettingsStore((s) => s.setActiveTabId);

  const tabs = useTabs(settingTabs);
  // active tab 兜底:未选 / id 不存在 → 取首项
  const active =
    tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  return (
    <Modal
      visible={isOpen}
      onClose={close}
      className="!max-w-[760px] !p-0"
    >
      <div className="flex h-[480px]">
        {/* 左侧 tab 列表 */}
        <nav className="w-[180px] shrink-0 border-r border-line bg-panel-soft py-2 text-xs">
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
        {/* 右侧内容 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-9 shrink-0 items-center justify-between border-b border-line px-4 text-xs">
            <span className="font-medium text-fg">{active?.title ?? '设置'}</span>
            <button
              type="button"
              onClick={close}
              aria-label="关闭"
              className="rounded px-1.5 py-0.5 text-fg-dim hover:bg-hover hover:text-fg"
            >
              ✕
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 text-xs text-fg-muted">
            {active ? active.render() : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
