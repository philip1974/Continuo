// 48px 竖向 Activity Bar(VSCode 风),Dockview 之外、main 之内。
// 顶部:内置导航(Explorer / Search)。中段:plugin 通过 ribbon 贡献的图标。
// 底部:Settings / Account 等元类。
// Explorer 按钮 toggle 左侧 Explorer Sidebar 显隐(active 状态显示左侧 accent bar);
// Search / Settings 占位待实现。

import { useEffect, useState } from 'react';
import { Folder } from '@react-symbols/icons';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { NavRailButton } from '@/design';
import { coApp } from '@/plugins/co-app';
import { toggleSettingsPanel } from '@/lib/toggle-settings-panel';
import { useUpdateStore } from '@/marketplace/update-store';
import type { RibbonActionSpec } from '@/plugins/registries/RibbonRegistry';
import { useT } from '@/i18n';

interface IconBarItemConfig {
  id: string;
  label: string;
  node: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

const ICON_SIZE = 22;

/** Lucide Settings 齿轮 SVG(stroke 风格,跟 Folder 等图标视觉一致). */
function SettingsGearIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function useRibbonActions(): readonly RibbonActionSpec[] {
  const [snapshot, setSnapshot] = useState(() => coApp.ribbon.getAll());
  useEffect(
    () => coApp.ribbon.subscribe(() => setSnapshot(coApp.ribbon.getAll())),
    [],
  );
  return snapshot;
}

export function IconSidebar() {
  const t = useT();
  const sidebarOpen = useLayoutUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutUiStore((s) => s.toggleSidebar);
  const ribbonActions = useRibbonActions();
  // Marketplace 更新数 → Settings 齿轮右上角红圈
  const updateCount = useUpdateStore((s) => s.available.length);

  const topItems: IconBarItemConfig[] = [
    {
      id: 'explorer',
      label: sidebarOpen
        ? t('shell.iconbar.hide_explorer')
        : t('shell.iconbar.show_explorer'),
      node: <Folder width={ICON_SIZE} height={ICON_SIZE} />,
      onClick: toggleSidebar,
      active: sidebarOpen,
    },
  ];

  const bottomItems: IconBarItemConfig[] = [
    {
      id: 'settings',
      label: t('shell.iconbar.settings'),
      node: <SettingsGearIcon size={ICON_SIZE} />,
      onClick: () => toggleSettingsPanel(),
    },
  ];

  const renderItem = (item: IconBarItemConfig) => (
    <NavRailButton
      key={item.id}
      title={item.label}
      active={item.active ?? false}
      disabled={item.disabled ?? false}
      onClick={item.onClick}
    >
      {item.node}
    </NavRailButton>
  );

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-line bg-panel py-2">
      <div className="flex flex-col items-center gap-1">
        {topItems.map(renderItem)}
        {ribbonActions.length > 0 && (
          <span
            className="my-1 h-px w-6 bg-line"
            aria-hidden="true"
          />
        )}
        {ribbonActions.map((r) => (
          <NavRailButton key={r.id} title={r.title} onClick={() => void r.onClick()}>
            {r.icon}
          </NavRailButton>
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        {bottomItems.map((item) =>
          item.id === 'settings' && updateCount > 0 ? (
            <div key={item.id} className="relative">
              {renderItem(item)}
              <span
                className="pointer-events-none absolute right-0.5 top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-error px-1 text-[9px] font-medium leading-none text-on-error"
                title={t('shell.iconbar.updates_tooltip', { count: updateCount })}
                aria-label={t('shell.iconbar.updates_tooltip', { count: updateCount })}
              >
                {updateCount > 9 ? '9+' : updateCount}
              </span>
            </div>
          ) : (
            renderItem(item)
          ),
        )}
        <AccountChip />
      </div>
    </aside>
  );
}

// 账户头像小卡(对齐 demo (3) 侧栏底部 profile chip)。
// Continuo IconSidebar 只有 48px 宽,放不下完整的「头像 + 名称 + Plan」,
// 退化为带 tooltip 的初字头像;后续接真实账户体系时再扩成弹层菜单。
function AccountChip() {
  const t = useT();
  return (
    <button
      type="button"
      className="mt-1 inline-flex h-7 w-7 items-center justify-center rounded-full border border-line bg-canvas text-2xs font-semibold tracking-wide text-fg-muted transition-colors hover:border-accent/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      title={t('shell.iconbar.account_title')}
      aria-label={t('shell.iconbar.account_aria')}
      onClick={() => {
        // TODO: 接入账户菜单(登录 / 切换 / 注销),目前仅占位
      }}
    >
      CD
    </button>
  );
}
