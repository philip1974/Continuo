// 应用内「选择文件夹」对话框的唯一出口:记住上次所选位置(见 open-dialog-last-dir.ts)。
// 菜单「在新窗口打开文件夹」与 renderer 的 fs:selectDirectory 共用同一份记忆。
import { dialog, type OpenDialogOptions } from 'electron';
import { createRememberingOpenDialog } from './open-dialog-last-dir';

export const showOpenDialogRemembering = createRememberingOpenDialog((opts: OpenDialogOptions) =>
  dialog.showOpenDialog(opts),
);
