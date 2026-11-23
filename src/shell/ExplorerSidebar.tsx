// Explorer 固定侧边栏(VSCode 风),挂在 IconSidebar 右侧、Dockview 左侧。
// 不参与 Dockview 拖拽。右边 4px 拖拽条改宽度,clamp 200-500;
// sidebarOpen / sidebarWidth 由 explorer.json 持久化(layoutUi 字段)。

import { useLayoutEffect, useRef, useState } from 'react';
import { Explorer } from '@/panels/Explorer';
import { ExplorerVisibleContext } from '@/panels/Explorer/visibility';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useLayoutUiStore,
} from '@/stores/layout-ui.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useColumnResize, clampWidth } from '@/lib/use-column-resize';
import { useT } from '@/i18n';

// a11y(A14):键盘调宽步长。Arrow=±STEP,Home/End=min/max。
const RESIZE_STEP = 16;

/** keptRoot 哨兵:尚无「对用户显示过」的文件树可保活。 */
const NONE = Symbol('none');

/**
 * 轻量 shell(打磨 R50,仿 R32/R33/R49):外层只订阅 sidebarOpen 与 workspace root,不订阅 sidebarWidth。
 * 宽度订阅、resize handler、useT 都在仅打开时挂载的 ExplorerSidebarResizer 里。
 *
 * perf(保活):关闭时**保持**用户看过的文件树挂载,只把 aside 置 hidden(display:none)。此前关闭
 * 即卸载 → 每次显隐 toggle 都对每个展开目录 unwatchDir,重开时 useTree 新实例丢 asyncDataLoader
 * 缓存、根与每个展开目录各 listDir(带 stat)+ watchDir,滚动位置丢失。保活期间 watcher 仍在(树
 * 不会陈旧),FolderTree 经 ExplorerVisibleContext 得知隐藏,把 dir-changed 刷新延后到再次显示。
 *
 * 只保活「对用户显示过、且 root 未变」的那棵树(keptRoot):启动即关闭、hydrate 前首帧开而 hydrate
 * 后关(首帧 root 尚为 null)、隐藏期间换了 root —— 这些情况下隐藏态不挂载文件树,不做任何 IO,
 * 与原先关闭即不渲染一致。
 */
export function ExplorerSidebar() {
  const open = useLayoutUiStore((s) => s.sidebarOpen);
  const root = useWorkspaceStore((s) => s.root);
  const [keptRoot, setKeptRoot] = useState<string | null | typeof NONE>(() =>
    open ? root : NONE,
  );
  // render 期同步本组件 state(React 支持的派生模式):打开时记录当前显示的 root;关闭后 root 变了即放弃保活。
  if (open) {
    if (keptRoot !== root) setKeptRoot(root);
  } else if (keptRoot !== NONE && keptRoot !== root) {
    setKeptRoot(NONE);
  }
  const keepAlive = !open && keptRoot !== NONE && keptRoot !== null && keptRoot === root;
  if (!open && !keepAlive) return null;

  return (
    <aside
      hidden={!open}
      className="relative shrink-0 border-r border-line bg-canvas"
    >
      <ExplorerVisibleContext.Provider value={open}>
        {/* Explorer 是 memo 组件且无 props:shell 重渲(开关)不级联重渲文件树,只经 context 通知可见性。 */}
        <Explorer />
      </ExplorerVisibleContext.Provider>
      {open && <ExplorerSidebarResizer />}
    </aside>
  );
}

/**
 * 仅打开时挂载:订阅 sidebarWidth,命令式写 aside 宽度(layout effect,首帧绘制前生效),并渲染右边
 * 拖拽条。宽度变化只重渲本组件,不碰 aside 内的文件树。
 * aside 经拖拽条的 parentElement 取得:挂载时父级 aside 的 ref 晚于子组件 layout effect 才挂上,
 * 而本组件自己 DOM 节点的 ref 在其 layout effect 前已就绪。
 */
function ExplorerSidebarResizer() {
  const t = useT();
  const width = useLayoutUiStore((s) => s.sidebarWidth);
  const setWidth = useLayoutUiStore((s) => s.setSidebarWidth);
  const resizeLabel = t('shell.aria.drag_resize');

  const handleRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const aside = handleRef.current?.parentElement;
    if (aside) aside.style.width = `${width}px`;
  }, [width]);

  const startResize = useColumnResize({
    getCurrent: () => useLayoutUiStore.getState().sidebarWidth,
    setCurrent: setWidth,
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
  });

  return (
    // 拖拽条:右边 4px 透明带,hover 显示 sky 高光.
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={resizeLabel}
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
      title={resizeLabel}
      className="absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none"
    />
  );
}
