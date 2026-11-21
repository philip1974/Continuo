import { type IpcMain } from 'electron';
import { registerPluginShellStreamHandlers } from '../services/plugin-shell-stream.service';

export function registerPluginShellStreamIpc({
  ipcMain,
}: {
  ipcMain: IpcMain;
}): void {
  registerPluginShellStreamHandlers(ipcMain);
}
