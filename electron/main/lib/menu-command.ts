// 应用菜单项即 renderer 命令(MENU_COMMAND_IDS):菜单点击 → 把执行请求发给目标主窗的 renderer(命令注册表在那里)。
// BDD: src/__tests__/explorer-commands/(第 5 条)、src/__tests__/app-menu-bar/

import { BrowserWindow, webContents, type BaseWindow } from 'electron';
import { isPopoutUrl } from '../popout-url';
import { sendToWindow } from './broadcast';
import {
  WINDOW_CHANNELS,
  type EditUndoRedoPayload,
  type MenuCommandId,
  type MenuCommandPayload,
} from '../../shared/window-channels';

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

/**
 * 发给目标主窗执行;无目标返回 false(调用方决定兜底)。附带 fromPopout(获焦的是 popout 子窗:命令作用于该子窗)与 viaKey
 *(由 accelerator 触发,见 MenuCommandPayload)。
 */
export function sendMenuCommand(win: BaseWindow | undefined, id: MenuCommandId, viaKey = false): boolean {
  const target = menuCommandTargetWindow(win);
  if (!target) return false;
  const payload: MenuCommandPayload = { id, fromPopout: target !== win, viaKey };
  sendToWindow(target, WINDOW_CHANNELS.RUN_MENU_COMMAND, payload, '[menu-command]');
  return true;
}

/**
 * 「编辑 → 撤销 / 重做」:按键触发(triggeredByAccelerator:按键已先经 renderer 而未被处理)→ 直接原生撤销 / 重做(同原 role 菜单项);
 * 鼠标点击 → 发给目标主窗按焦点分派(文件树聚焦 → 撤销文件操作,见 EDIT_UNDO_REDO),无可用主窗 → 原生。
 * 原生作用于获焦的 webContents(含 popout 子窗、DevTools),没有则作用于 win。
 */
export function runEditUndoRedo(win: BaseWindow | undefined, op: EditUndoRedoPayload['op'], viaKey: boolean): void {
  const target = viaKey ? null : menuCommandTargetWindow(win);
  if (target) {
    // DevTools 获焦(它的 webContents 不属于任何 BrowserWindow)→ 原生,不交给页面
    const focused = webContents.getFocusedWebContents();
    if (!focused || BrowserWindow.fromWebContents(focused) !== null) {
      const payload: EditUndoRedoPayload = { op, fromPopout: target !== win };
      sendToWindow(target, WINDOW_CHANNELS.EDIT_UNDO_REDO, payload, '[menu-undo]');
      return;
    }
  }
  nativeUndoRedo(win, op);
}

/** 原生撤销 / 重做:获焦的 webContents(含 DevTools),否则 win 的。 */
export function nativeUndoRedo(win: BaseWindow | undefined, op: EditUndoRedoPayload['op']): void {
  const contents =
    webContents.getFocusedWebContents() ?? (win instanceof BrowserWindow && !win.isDestroyed() ? win.webContents : null);
  if (!contents || contents.isDestroyed()) return;
  if (op === 'undo') contents.undo();
  else contents.redo();
}
