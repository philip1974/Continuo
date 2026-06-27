// Explorer 固定侧边栏(VSCode 风),挂在 IconSidebar 右侧、Dockview 左侧。
// 不参与 Dockview 拖拽。右边 4px 拖拽条改宽度,clamp 200-500;
// sidebarOpen / sidebarWidth 由 explorer.json 持久化(layoutUi 字段)。

import { Explorer } from '@/panels/Explorer';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useLayoutUiStore,
} from '@/stores/layout-ui.store';
import { useColumnResize, clampWidth } from '@/lib/use-column-resize';
import { useT } from '@/i18n';

// a11y(A14):键盘调宽步长。Arrow=±STEP,Home/End=min/max。
const RESIZE_STEP = 16;

/**
 * 轻量 shell(打磨 R50,仿 R32/R33/R49):外层只订阅 sidebarOpen,关闭直接返回 null。
 * 仅打开时挂载 ExplorerSidebarBody —— 关闭状态下不订阅 sidebarWidth、不创建 resize
 * handler、不跑 useT。宽度持久化恢复 / 切语言 / 其他 layout 更新不碰不可见 sidebar。
 */
export function ExplorerSidebar() {
  const open = useLayoutUiStore((s) => s.sidebarOpen);
  if (!open) return null;
  return <ExplorerSidebarBody />;
}

function ExplorerSidebarBody() {
  const t = useT();
  const width = useLayoutUiStore((s) => s.sidebarWidth);
  const setWidth = useLayoutUiStore((s) => s.setSidebarWidth);

  const startResize = useColumnResize({
    getCurrent: () => useLayoutUiStore.getState().sidebarWidth,
    setCurrent: setWidth,
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    direction: 'left-to-right',
  });

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
        aria-label={t('shell.aria.drag_resize')}
        // a11y(A14):separator 此前只 onMouseDown,键盘用户无法聚焦/调宽,AT 不知范围/值。
        // 加 tabIndex + aria-valuemin/max/now(window-splitter 模式)+ Arrow/Home/End 键盘调宽。
        tabIndex={0}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        onMouseDown={startResize}
        onKeyDown={(e) => {
          let next: number | null = null;
          if (e.key === 'ArrowLeft') next = width - RESIZE_STEP;
          else if (e.key === 'ArrowRight') next = width + RESIZE_STEP;
          else if (e.key === 'Home') next = SIDEBAR_MIN_WIDTH;
          else if (e.key === 'End') next = SIDEBAR_MAX_WIDTH;
          if (next !== null) {
            e.preventDefault();
            setWidth(clampWidth(next, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
          }
        }}
        title={t('shell.aria.drag_resize')}
        className="absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none"
      />
    </aside>
  );
}
