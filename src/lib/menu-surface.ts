// 菜单浮层的共享外观(Explorer / 终端 / tab 与列表行右键菜单、DropdownMenu「⋯」):panel 底 + line 描边 + shadow-popover
//(两主题各有取值)。高度不超过可用空间,超出时菜单内纵向滚动(VSCode 上下文菜单同:窗口矮时菜单限高、出现滚动条);
// 键盘 ↓ / End 把焦点移到屏外的项时,focus() 自带滚动使其可见。BDD: src/__tests__/menu-overflow-scroll/

/** 浮层外观 + 纵向滚动(不含最小宽 / 最大高:各菜单自定)。 */
export const MENU_SURFACE_CLASS_NAME =
  'overflow-x-hidden overflow-y-auto overscroll-contain rounded-md border border-line bg-panel py-1 shadow-popover outline-none';

/**
 * Radix ContextMenu.Content:最大高 = Radix 按视口与锚点算出的可用高度(`--radix-context-menu-content-available-height`,
 * 已扣除翻转 / 平移后的可用空间)。
 */
export const CONTEXT_MENU_CONTENT_CLASS_NAME = `min-w-[180px] max-h-[var(--radix-context-menu-content-available-height)] ${MENU_SURFACE_CLASS_NAME}`;

/** 菜单离视口底边至少留的距离(px)。 */
export const MENU_VIEWPORT_MARGIN = 4;

/** 按锚点顶边(视口坐标)算 position:fixed 菜单的最大高度(视口高 - 顶边 - 边距,至少 0)。 */
export function menuMaxHeightBelow(top: number, viewportHeight: number): number {
  return Math.max(0, viewportHeight - top - MENU_VIEWPORT_MARGIN);
}
