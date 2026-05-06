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
import { openOrFocusPanel } from '@/shell/dock/dock-api-ref';
import { useUpdateStore } from '@/marketplace/update-store';
import type { RibbonActionSpec } from '@/plugins/registries/RibbonRegistry';

interface IconBarItemConfig {
  id: string;
  label: string;
  node: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

const ICON_SIZE = 22;

function useRibbonActions(): readonly RibbonActionSpec[] {
  const [snapshot, setSnapshot] = useState(() => coApp.ribbon.getAll());
  useEffect(
    () => coApp.ribbon.subscribe(() => setSnapshot(coApp.ribbon.getAll())),
    [],
  );
  return snapshot;
}

export function IconSidebar() {
  const sidebarOpen = useLayoutUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutUiStore((s) => s.toggleSidebar);
  const ribbonActions = useRibbonActions();
  // Marketplace 更新数 → Settings 齿轮右上角红圈
  const updateCount = useUpdateStore((s) => s.available.length);

  const topItems: IconBarItemConfig[] = [
    {
      id: 'explorer',
      label: sidebarOpen ? '隐藏 Explorer' : '显示 Explorer',
      node: <Folder width={ICON_SIZE} height={ICON_SIZE} />,
      onClick: toggleSidebar,
      active: sidebarOpen,
    },
    {
      id: 'search',
      label: '搜索(待实现)',
      node: <span className="text-xl leading-none">⌕</span>,
      onClick: () => {},
      disabled: true,
    },
  ];

  const bottomItems: IconBarItemConfig[] = [
    {
      id: 'settings',
      label: '设置',
      node: <span className="text-xl leading-none">⚙</span>,
      onClick: () => openOrFocusPanel('settings', 'settings', 'Settings'),
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
                className="pointer-events-none absolute right-0.5 top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-medium leading-none text-white"
                title={`${updateCount} 个插件可更新`}
                aria-label={`${updateCount} 个插件可更新`}
              >
                {updateCount > 9 ? '9+' : updateCount}
              </span>
            </div>
          ) : (
            renderItem(item)
          ),
        )}
      </div>
    </aside>
  );
}
