import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  PANEL_MOUNT_ANIMATE,
  PANEL_MOUNT_EXIT,
  PANEL_MOUNT_INITIAL,
  PANEL_MOUNT_TRANSITION,
} from './tokens';
import { useClosingStore } from './closing-store';

// 进场:initial → animate(在 panels 注册处包一层即可触发)。
// 退场:dockview 没有 onWillRemovePanel,无法直接挂 AnimatePresence。
// 折中:SharedTab 的 close handler 先把 id 放进 closing-store + setTimeout,
// 这一层订阅 store,isClosing 时 animate 到 EXIT,200ms 后 dockview 真 unmount。
export function PanelMount({ panelId, children }: { panelId: string; children: ReactNode }) {
  const isClosing = useClosingStore((s) => s.ids.has(panelId));
  return (
    <motion.div
      initial={PANEL_MOUNT_INITIAL}
      animate={isClosing ? PANEL_MOUNT_EXIT : PANEL_MOUNT_ANIMATE}
      transition={PANEL_MOUNT_TRANSITION}
      className="h-full w-full"
    >
      {children}
    </motion.div>
  );
}
