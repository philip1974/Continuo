// 触发按钮弹出的菜单(Explorer 头部「⋯」与 dock 面板头部「⋯」共用;此前两处各装配一遍,焦点还原已分叉)。
//
// 必须 portal 到 document.body:Dockview 祖先有 transform: translate3d(0,0,0) 创建 stacking context,会把 z-modal
// 困在 panel header 子树内、被相邻 panel content 盖住。portal 出去后 position:fixed 才真按 viewport 定位。
// 触发按钮仍由调用方渲染(尺寸 / 样式各异),须带 aria-haspopup="menu" + aria-expanded。
import { createPortal } from 'react-dom';
import type { ReactNode, RefObject } from 'react';
import { useMenuKeyboard } from './use-menu-keyboard';
import { useMenuAnchor } from './use-menu-anchor';
import { useDismissOnOutsidePointer } from './use-dismiss-on-outside-pointer';

export interface DropdownMenuControls {
  /** 只关闭菜单(焦点交给随后的动作,如新建的面板)。 */
  readonly close: () => void;
  /** a11y(A30):关闭并把焦点还给触发按钮(否则菜单卸载后焦点落到 body)。 */
  readonly closeAndRestore: () => void;
}

export interface DropdownMenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly triggerRef: RefObject<HTMLElement | null>;
  /**
   * 点外部关闭时视为「内部」的元素(缺省只有触发按钮)。如 dock 面板头部传整个 header 容器:点同组的
   * popout 按钮不关菜单。
   */
  readonly dismissInsideRef?: RefObject<Node | null>;
  readonly children: (controls: DropdownMenuControls) => ReactNode;
}

export function DropdownMenu({
  open,
  onOpenChange,
  triggerRef,
  dismissInsideRef,
  children,
}: DropdownMenuProps) {
  const close = () => onOpenChange(false);
  // a11y(A18):打开移焦入首项 + Escape / Tab 关闭还原焦点 + 方向键漫游。
  const { menuRef, menuNode, onKeyDown, closeAndRestore } = useMenuKeyboard({
    triggerRef,
    onClose: close,
  });
  const anchor = useMenuAnchor(triggerRef, open);
  useDismissOnOutsidePointer(open, [dismissInsideRef ?? triggerRef, menuNode], close);

  if (!open || !anchor) return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      onKeyDown={onKeyDown}
      style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
      className="z-modal min-w-[140px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-popover"
    >
      {children({ close, closeAndRestore })}
    </div>,
    document.body,
  );
}
