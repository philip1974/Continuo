import { BrowserWindow } from 'electron';
import { isPopoutUrl } from '../popout-url';

export interface MainWindowCandidate {
  readonly id: number;
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    getURL(): string;
  };
}

/**
 * 窗口与其 webContents 都还活着。关窗中间态窗口未销毁但 webContents 已销毁,此时 getURL() 抛 "Object has been
 * destroyed" —— 读 URL 判 popout 之前须先过这一关(选窗 / 授权弹窗 / 退出 flush 共用)。
 */
export function isWindowUsable(win: MainWindowCandidate): boolean {
  return !win.isDestroyed() && !win.webContents.isDestroyed();
}

export function pickMainWindowPreferNonPopout(): BrowserWindow | null;
export function pickMainWindowPreferNonPopout<T extends MainWindowCandidate>(
  windows: readonly T[],
): T | null;
export function pickMainWindowPreferNonPopout(
  windows: readonly MainWindowCandidate[] = BrowserWindow.getAllWindows(),
): MainWindowCandidate | null {
  let firstLive: MainWindowCandidate | null = null;
  for (const win of windows) {
    if (!isWindowUsable(win)) continue;
    if (firstLive === null) firstLive = win;
    if (!isPopoutUrl(win.webContents.getURL())) return win;
  }
  return firstLive;
}
