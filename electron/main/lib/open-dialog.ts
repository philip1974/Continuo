// 应用内「选择文件夹」对话框的唯一出口:记住上次所选位置(见 open-dialog-last-dir.ts)。
// 菜单「在新窗口打开文件夹」与 renderer 的 fs:selectDirectory 共用同一份记忆。
// parent:对话框模态于该窗口(macOS 为挂在窗口上的 sheet,不会落到别的屏 / 别的窗口后面);同 VSCode dialogMainService
// `showOpenDialog(options, window || BrowserWindow.getFocusedWindow())`。没有窗口 → 独立对话框。
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { createRememberingOpenDialog } from './open-dialog-last-dir';

export const showOpenDialogRemembering = createRememberingOpenDialog(
  (opts: OpenDialogOptions, parent: BrowserWindow | null | undefined) =>
    parent && !parent.isDestroyed() ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts),
);
