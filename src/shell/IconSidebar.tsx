// 48px 竖向 Activity Bar(VSCode 风),Dockview 之外、main 之内。
// Explorer 按钮 toggle 左侧 Explorer Sidebar 显隐(active 状态显示左侧 accent bar);
// Search / Settings 占位待实现。

import { Folder } from '@react-symbols/icons';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { NavRailButton } from '@/design';

interface IconBarItemConfig {
  id: string;
  label: string;
  node: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

const ICON_SIZE = 22;

export function IconSidebar() {
  const sidebarOpen = useLayoutUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutUiStore((s) => s.toggleSidebar);

  const items: IconBarItemConfig[] = [
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
    {
      id: 'settings',
      label: '设置(待实现)',
      node: <span className="text-xl leading-none">⚙</span>,
      onClick: () => {},
      disabled: true,
    },
  ];

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
      {items.map((item) => (
        <NavRailButton
          key={item.id}
          title={item.label}
          active={item.active ?? false}
          disabled={item.disabled ?? false}
          onClick={item.onClick}
        >
          {item.node}
        </NavRailButton>
      ))}
    </aside>
  );
}
