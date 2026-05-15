// Explorer 固定侧边栏(VSCode 风),挂在 IconSidebar 右侧、Dockview 左侧。
// 不参与 Dockview 拖拽。右边 4px 拖拽条改宽度,clamp 200-500;
// sidebarOpen / sidebarWidth 由 explorer.json 持久化(layoutUi 字段)。

import { Explorer } from '@/panels/Explorer';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useLayoutUiStore,
} from '@/stores/layout-ui.store';
import { useColumnResize } from '@/lib/use-column-resize';

export function ExplorerSidebar() {
  const open = useLayoutUiStore((s) => s.sidebarOpen);
  const width = useLayoutUiStore((s) => s.sidebarWidth);
  const setWidth = useLayoutUiStore((s) => s.setSidebarWidth);

  const startResize = useColumnResize({
    getCurrent: () => useLayoutUiStore.getState().sidebarWidth,
    setCurrent: setWidth,
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    direction: 'left-to-right',
  });

  if (!open) return null;

  return (
    <aside
      style={{ width }}
      className="relative shrink-0 border-r border-line bg-canvas"
    >
      <Explorer />
      {/* 拖拽条:右边 4px 透明带,hover 显示 sky 高光. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽改变宽度"
        onMouseDown={startResize}
        title="拖拽改变宽度"
        className="absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40"
      />
    </aside>
  );
}
