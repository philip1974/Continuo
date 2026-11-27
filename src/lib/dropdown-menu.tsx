// 触发按钮弹出的菜单(Explorer 头部「⋯」与 dock 面板头部「⋯」共用;此前两处各装配一遍,焦点还原已分叉)。
//
// 必须 portal 到触发按钮所在文档的 body(dock 组弹出到 popout 子窗时 header 在子窗 DOM,全局 document 是主窗):Dockview 祖先有 transform: translate3d(0,0,0) 创建 stacking context,会把 z-modal
// 困在 panel header 子树内、被相邻 panel content 盖住。portal 出去后 position:fixed 才真按 viewport 定位。
// 触发按钮仍由调用方渲染(尺寸 / 样式各异),须带 aria-haspopup="menu" + aria-expanded。
import { createPortal } from 'react-dom';
import { useEffect, useRef, type FocusEvent, type ReactNode, type RefObject } from 'react';
import { useMenuKeyboard } from './use-menu-keyboard';
import { useMenuAnchor } from './use-menu-anchor';
import { useDismissOnOutsidePointer } from './use-dismiss-on-outside-pointer';
import { MENU_SURFACE_CLASS_NAME } from './menu-surface';

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
  readonly children: (controls: DropdownMenuControls) => ReactNode;
}

export function DropdownMenu({
  open,
  onOpenChange,
  triggerRef,
  children,
}: DropdownMenuProps) {
  const close = () => onOpenChange(false);
  // a11y(A18):打开移焦入首项 + Escape / Tab 关闭还原焦点 + 方向键漫游。
  const { menuRef, menuNode, onKeyDown, closeAndRestore } = useMenuKeyboard({
    triggerRef,
    onClose: close,
  });
  const anchor = useMenuAnchor(triggerRef, open);
  // 「内部」只有触发按钮与菜单(VSCode:菜单开着时点菜单外任何位置——含相邻工具栏按钮,如 dock 头部同组的弹出按钮——都先关菜单)。
  useDismissOnOutsidePointer(open, [triggerRef, menuNode], close);
  // 焦点移出菜单(且不在触发按钮里)→ 关闭(VSCode 上下文菜单失焦即关):否则别处把焦点移走后菜单留在屏上,
  // 菜单自己的 Esc 也收不到。relatedTarget 为 null(焦点去了 body / 窗口失焦)同样关闭。
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && (menuNode.current?.contains(next) || triggerRef.current?.contains(next))) return;
    close();
  };
  // 文档级 Esc:焦点不在菜单里时(菜单自己的 onKeyDown 收不到)也能关;焦点仍在菜单内则还给触发按钮。
  const latest = useRef({ close, closeAndRestore });
  latest.current = { close, closeAndRestore };
  useEffect(() => {
    if (!open) return;
    const doc = triggerRef.current?.ownerDocument ?? document;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (menuNode.current?.contains(doc.activeElement)) latest.current.closeAndRestore();
      else latest.current.close();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [open, triggerRef, menuNode]);

  if (!open || !anchor) return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      // 可聚焦(不进 Tab 顺序):点菜单内的空白 / 分隔线时焦点落在菜单上而非 body,不触发失焦关闭。
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      style={{ position: 'fixed', top: anchor.top, right: anchor.right, maxHeight: anchor.maxHeight }}
      className={`z-modal min-w-[140px] ${MENU_SURFACE_CLASS_NAME}`}
    >
      {children({ close, closeAndRestore })}
    </div>,
    (triggerRef.current?.ownerDocument ?? document).body,
  );
}
