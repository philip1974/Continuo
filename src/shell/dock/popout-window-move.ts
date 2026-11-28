// dockview popout 子窗「移动结束」改为事件驱动:main 在子窗 BrowserWindow 'move' 时推 window:popout-moved(子窗名),
// 这里把它接到构建期改写后的 dockview onDidWindowMoveEnd(见 scripts/vite-dockview-popout-move.ts)。上游每帧 rAF 轮询
// 子窗 screenX / screenY,开着 popout 时主 renderer 一直按刷新率跑(最小化也不停,backgroundThrottling 已关)。
// BDD: src/__tests__/popout-window-move/

import { POPOUT_MOVE_HOOK_GLOBAL } from '@shared/window-channels';
import { coApi } from '@/lib/co-api';

export type PopoutMoveSubscribe = (popout: Window, onMove: () => void) => () => void;

/** 子窗名 = dockview window.open 的名字(每个 popout 组唯一);只回调被移动的那个子窗。 */
export const subscribePopoutMove: PopoutMoveSubscribe = (popout, onMove) =>
  coApi.window.onPopoutMoved((name) => {
    if (!popout.closed && name === popout.name) onMove();
  });

/** 主窗 renderer 启动时装上(dockview 建 popout 前)。 */
export function installPopoutWindowMoveHook(): void {
  (globalThis as Record<string, unknown>)[POPOUT_MOVE_HOOK_GLOBAL] = subscribePopoutMove;
}
