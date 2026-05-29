import { app, type IpcMain } from 'electron';
import { registerPluginDataStoreHandlers } from '../services/plugin-data-store.service';

export function registerPluginDataIpc(args: { ipcMain: IpcMain }): void {
  registerPluginDataStoreHandlers(args.ipcMain, {
    userDataPath: app.getPath('userData'),
  });
}
