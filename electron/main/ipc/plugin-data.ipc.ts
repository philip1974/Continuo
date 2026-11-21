import { app, type IpcMain } from 'electron';
import { registerPluginDataStoreHandlers } from '../services/plugin-data-store.service';
import { withTrustedFrameGate } from '../safe-handle';

export function registerPluginDataIpc(args: { ipcMain: IpcMain }): void {
  // frame-trust 门:plugin-data 只凭 renderer 自报的 pluginId(无 token),必须只接受可信 frame。
  registerPluginDataStoreHandlers(withTrustedFrameGate(args.ipcMain), {
    userDataPath: app.getPath('userData'),
  });
}
