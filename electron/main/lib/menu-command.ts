// 应用菜单项即 renderer 命令(MENU_COMMANDS):菜单点击 → 把执行请求发给目标主窗的 renderer(命令注册表在那里)。
// BDD: src/__tests__/explorer-commands/(第 5 条)

import { BrowserWindow, webContents, type BaseWindow } from 'electron';
import { isPopoutUrl } from '../popout-url';
import { sendToWindow } from './broadcast';
import { WINDOW_CHANNELS, type MenuCommandId } from '../../shared/window-channels';

/**
 * 菜单点击的目标主窗:主窗即自身;dockview popout 子窗 → 打开它的主窗(子窗界面由主窗 renderer 驱动,子窗自己的
 * webContents 不跑应用代码);没有 / 已销毁 / 找不到主窗 → null。
 */
export function menuCommandTargetWindow(win: BaseWindow | undefined): BrowserWindow | null {
  if (!(win instanceof BrowserWindow) || win.isDestroyed()) return null;
  if (!isPopoutUrl(win.webContents.getURL())) return win;
  const opener = win.webContents.opener;
  const ownerContents = opener ? webContents.fromFrame(opener) : undefined;
  const owner = ownerContents ? BrowserWindow.fromWebContents(ownerContents) : null;
  return owner && !owner.isDestroyed() ? owner : null;
}

/** 发给目标主窗执行;无目标返回 false(调用方决定兜底)。 */
export function sendMenuCommand(win: BaseWindow | undefined, id: MenuCommandId): boolean {
  const target = menuCommandTargetWindow(win);
  if (!target) return false;
  sendToWindow(target, WINDOW_CHANNELS.RUN_MENU_COMMAND, id, '[menu-command]');
  return true;
}
