// 溢出菜单(⋯)的锚点坐标 hook(ExplorerHeader 与 dock HeaderActions 共用;此前两处逐字复制)。
//
// 菜单 portal 到 document.body 后用 position:fixed 按 viewport 定位(dockview 祖先的 transform 会建
// stacking context,把菜单困在 panel header 子树内)。坐标取 trigger 按钮的 viewport rect:菜单顶边
// 在按钮下方 4px、右边与按钮右缘对齐。打开期间监听 resize / scroll(capture)重算,避免侧边栏滚动 /
// 窗口缩放后菜单错位。

import { useLayoutEffect, useState } from 'react';
import type React from 'react';

export interface MenuAnchor {
  readonly top: number;
  readonly right: number;
}

export function useMenuAnchor(
  triggerRef: React.RefObject<HTMLElement | null>,
  open: boolean,
): MenuAnchor | null {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setAnchor({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, triggerRef]);
  return anchor;
}
