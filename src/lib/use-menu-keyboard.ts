import { useCallback, useRef, type KeyboardEvent, type RefObject } from 'react';

/**
 * a11y(A18):role="menu" 弹层的键盘焦点管理 —— 共享单一来源。
 *
 * ExplorerHeader 的「更多操作」⋯ 菜单与 dock/HeaderActions 的面板菜单是同一模式
 * (trigger 按钮 + portal 出去的 role="menu" + 一组 role="menuitem" 按钮),此前都只
 * 把菜单挂进 DOM,**焦点仍停在触发按钮**,键盘用户打开后无法直接用方向键/Enter 操作
 * 菜单项,也没有 Escape 关闭并还原焦点。本 hook 补齐 WAI-ARIA menu 键盘契约:
 *  - 菜单节点挂载时把焦点移入第一个可用 menuitem;
 *  - Escape 关闭菜单并把焦点还原到触发按钮;
 *  - ArrowDown/ArrowUp 在 menuitem 间循环漫游,Home/End 跳首尾。
 *
 * 用法:把返回的 `menuRef`(callback ref)挂到 role="menu" 容器的 ref,`onKeyDown`
 * 挂到同一容器;需要 contains() 判定时读 `menuNode.current`。
 *
 * 注意:聚焦走 callback ref 而非 useEffect([open]) —— 菜单常 portal 且坐标在
 * layoutEffect 后才算出(open 翻 true 的那次 render 菜单尚未挂载),callback ref 在节点
 * 真正 attach 时触发,才能可靠拿到 menuitem。
 */
export function useMenuKeyboard(opts: {
  readonly open: boolean;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): {
  readonly menuRef: (node: HTMLElement | null) => void;
  readonly menuNode: RefObject<HTMLElement | null>;
  readonly onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  readonly closeAndRestore: () => void;
} {
  const { open, triggerRef, onClose } = opts;
  const menuNode = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  // callback ref:菜单节点挂载即把焦点移入首个可用 menuitem(unmount 时置 null)。
  const menuRef = useCallback((node: HTMLElement | null) => {
    menuNode.current = node;
    if (node && openRef.current) getMenuItems(node)?.[0]?.focus();
  }, []);

  // a11y(A30):关闭菜单并把焦点还原到触发按钮。供「不会主动聚焦新目标」的菜单项激活时调用
  // (Enter/点击普通项后菜单卸载,否则焦点落到被卸载元素/body)。Escape 路径复用同一逻辑。
  const closeAndRestore = () => {
    onClose();
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRestore();
      return;
    }
    // a11y(A31):menuitem 都 tabIndex=-1(不在 Tab 顺序)。Tab/Shift+Tab 关闭菜单并把焦点
    // 还原到触发按钮(WAI-ARIA menu:Tab 关闭菜单),避免焦点 leak 到 portal 之后的 DOM。
    if (e.key === 'Tab') {
      e.preventDefault();
      closeAndRestore();
      return;
    }
    const items = getMenuItems(menuNode.current);
    if (!items || items.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const idx = current ? indexOfMenuItem(items, current) : -1;
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % items.length;
    else if (e.key === 'ArrowUp') next = idx <= 0 ? items.length - 1 : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next !== null) {
      e.preventDefault();
      items[next]?.focus();
    }
  };

  return { menuRef, menuNode, onKeyDown, closeAndRestore };
}

/** 菜单内所有「可用」menuitem(排除 disabled),按 DOM 顺序。 */
function getMenuItems(
  menu: HTMLElement | null,
): NodeListOf<HTMLButtonElement> | null {
  if (!menu) return null;
  return menu.querySelectorAll<HTMLButtonElement>(
    '[role="menuitem"]:not([disabled])',
  );
}

function indexOfMenuItem(
  items: NodeListOf<HTMLButtonElement>,
  current: HTMLElement,
): number {
  for (let i = 0; i < items.length; i += 1) {
    if (items[i] === current) return i;
  }
  return -1;
}
