// 弹出菜单「点外部即关闭」:打开期间在 document 上听 pointerdown,目标不在任一 inside 元素内 → close。
// 「内部」范围由调用方给(ExplorerHeader:触发按钮 + 菜单;dock HeaderActions:整个 header 容器 + 菜单)。
// 此前两处各写一份 effect。close 取最新渲染的。
import { useEffect, useRef, type RefObject } from 'react';

export function useDismissOnOutsidePointer(
  open: boolean,
  inside: readonly RefObject<Node | null>[],
  close: () => void,
): void {
  const latest = useRef({ inside, close });
  latest.current = { inside, close };
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!latest.current.inside.some((r) => r.current?.contains(target) ?? false)) {
        latest.current.close();
      }
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [open]);
}
