// dockview popout 子窗移动 → 通知打开它的主窗 renderer(payload = 子窗 window.open 名)。renderer 侧由构建期改写的
// dockview onDidWindowMoveEnd 订阅(见 scripts/vite-dockview-popout-move.ts),取代上游每帧 rAF 轮询 screenX / screenY。
// 'move' 各平台在移动过程中 / 程序化 setBounds 时都会发(macOS 的 'moved' 是它的别名);防抖留给 renderer(同上游 100ms)。
// BDD: src/__tests__/popout-window-move/

import { WINDOW_CHANNELS } from '../shared/window-channels';

interface PopoutChild {
  on(event: 'move', listener: () => void): unknown;
  isDestroyed(): boolean;
  readonly webContents: { isDestroyed(): boolean; readonly mainFrame: { readonly name: string } };
}

interface PopoutOpener {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export function forwardPopoutMoves(child: PopoutChild, opener: PopoutOpener): void {
  child.on('move', () => {
    if (opener.isDestroyed() || child.isDestroyed() || child.webContents.isDestroyed()) return;
    opener.send(WINDOW_CHANNELS.POPOUT_MOVED, child.webContents.mainFrame.name);
  });
}
