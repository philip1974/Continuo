// 48px 竖向 Activity Bar(VSCode 风),Dockview 之外、main 之内。
// 当前按钮:Explorer(聚焦面板)/ Search(占位) / Settings(占位)。
// 后续添加:Source Control / Run / Extensions 等真正面板。

import { Folder } from '@react-symbols/icons';
import { focusPanel } from './dock/dock-api-ref';

interface IconBarItem {
  id: string;
  label: string;
  node: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

const ICON_SIZE = 22;

const items: IconBarItem[] = [
  {
    id: 'explorer',
    label: 'Explorer(聚焦)',
    node: <Folder width={ICON_SIZE} height={ICON_SIZE} />,
    onClick: () => focusPanel('explorer'),
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

export function IconSidebar() {
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
          className="flex h-9 w-9 items-center justify-center rounded text-fg-muted transition hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
        >
          {item.node}
        </button>
      ))}
    </aside>
  );
}
