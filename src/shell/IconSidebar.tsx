// 48px 竖向 Activity Bar(VSCode 风),Dockview 之外、main 之内。
// Explorer 按钮 toggle 左侧 Explorer Sidebar 显隐(active 状态显示左侧 accent bar);
// Search / Settings 占位待实现。

import { Folder } from '@react-symbols/icons';
import { useLayoutUiStore } from '@/stores/layout-ui.store';

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
        <button
          key={item.id}
          type="button"
          onClick={item.onClick}
          disabled={item.disabled}
          title={item.label}
          aria-label={item.label}
          className={[
            'relative flex h-9 w-9 items-center justify-center rounded transition',
            item.active
              ? 'text-fg'
              : 'text-fg-muted hover:bg-hover hover:text-fg',
            'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted',
          ].join(' ')}
        >
          {item.active && (
            <span
              className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-accent"
              aria-hidden="true"
            />
          )}
          {item.node}
        </button>
      ))}
    </aside>
  );
}
