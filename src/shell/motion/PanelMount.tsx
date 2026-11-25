import type { ReactNode, Ref } from 'react';
import { m } from 'motion/react';
import {
  PANEL_MOUNT_ANIMATE,
  PANEL_MOUNT_EXIT,
  PANEL_MOUNT_INITIAL,
  PANEL_MOUNT_TRANSITION,
} from './tokens';
import { useClosingStore } from '@/stores/closing.store';

// 进场:initial → animate(在 panels 注册处包一层即可触发)。
// 退场:dockview 没有 onWillRemovePanel,无法直接挂 AnimatePresence。
// 折中:wrap-panel-close.ts 包住 panel 的 close,先把 id 放进 closing-store + setTimeout,
// 这一层订阅 store,isClosing 时 animate 到 EXIT,EXIT_DURATION_MS 后 dockview 真 unmount。
export function PanelMount({
  panelId,
  children,
  ref,
}: {
  panelId: string;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  const isClosing = useClosingStore((s) => s.ids.has(panelId));
  return (
    <m.div
      ref={ref}
      initial={PANEL_MOUNT_INITIAL}
      animate={isClosing ? PANEL_MOUNT_EXIT : PANEL_MOUNT_ANIMATE}
      transition={PANEL_MOUNT_TRANSITION}
      className="h-full w-full"
    >
      {children}
    </m.div>
  );
}
