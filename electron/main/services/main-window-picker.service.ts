import { BrowserWindow } from 'electron';
import { isPopoutUrl } from '../popout-url';

export interface MainWindowCandidate {
  readonly id: number;
  isDestroyed(): boolean;
  readonly webContents: {
    getURL(): string;
  };
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
    if (win.isDestroyed()) continue;
    if (firstLive === null) firstLive = win;
    if (!isPopoutUrl(win.webContents.getURL())) return win;
  }
  return firstLive;
}
