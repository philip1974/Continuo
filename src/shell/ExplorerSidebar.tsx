// Explorer 固定侧边栏(VSCode 风),挂在 IconSidebar 右侧、Dockview 左侧。
// 不参与 Dockview 拖拽 — 用户不能把它拖到任意位置。
// MVP 固定宽 280px;后续可加拖拽改宽(借鉴 Lokus useColumnResize)。

import { Explorer } from '@/panels/Explorer';
import { useLayoutUiStore } from '@/stores/layout-ui.store';

const SIDEBAR_WIDTH = 280;

export function ExplorerSidebar() {
  const open = useLayoutUiStore((s) => s.sidebarOpen);
  if (!open) return null;
  return (
    <aside
      style={{ width: SIDEBAR_WIDTH }}
      className="shrink-0 border-r border-line bg-canvas"
    >
      <Explorer />
    </aside>
  );
}
