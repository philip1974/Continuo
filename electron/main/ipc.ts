import { app, ipcMain } from 'electron';
import path from 'node:path';
import { loadLayout, saveLayout } from './persistence';

export function registerIpc() {
  const layoutFile = path.join(app.getPath('userData'), 'layout.json');

  ipcMain.handle('layout:read', async () => {
    return loadLayout(layoutFile);
  });

  ipcMain.handle('layout:write', async (_evt, json: unknown) => {
    try {
      return await saveLayout(layoutFile, json);
    } catch (err) {
      console.error('[ipc] layout:write rejected', err);
      return false;
    }
  });

  // popout 通道 v2 再实现,M2 占位
  ipcMain.handle('popout:open', async () => ({ ok: false as const }));
}
