import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  PANEL_MOUNT_ANIMATE,
  PANEL_MOUNT_INITIAL,
  PANEL_MOUNT_TRANSITION,
} from './tokens';

// 进场动画包装。退场不在 v1 范围:
// dockview 直接控制 panel body 的 unmount,AnimatePresence 在这一层
// 拿不到 unmount 通知。需要的话 v2 再下沉到 dockview 生命周期。
export function PanelMount({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={PANEL_MOUNT_INITIAL}
      animate={PANEL_MOUNT_ANIMATE}
      transition={PANEL_MOUNT_TRANSITION}
      className="h-full w-full"
    >
      {children}
    </motion.div>
  );
}
