import { app, ipcMain } from 'electron';
import { registerPluginDataStoreHandlers } from '../services/plugin-data-store.service';
import { withTrustedFrameGate } from '../safe-handle';
import { broadcastToWindows, SKIP_BROADCAST } from '../lib/broadcast';
import { PLUGIN_DATA_CHANNELS } from '../../shared/plugin-data-channels';

export function registerPluginDataIpc(): void {
  // frame-trust 门:plugin-data 只凭 renderer 自报的 pluginId(无 token),必须只接受可信 frame。
  registerPluginDataStoreHandlers(withTrustedFrameGate(ipcMain), {
    userDataPath: app.getPath('userData'),
    // 跨窗口缓存失效(同 _enabled / _permissions 写后广播):每个主窗口各缓存插件数据、插件整份读-改-写,
    // 不通知则陈旧窗口的整份写抹掉本次改动。发起窗口的缓存已在 save 成功后提交为新值,跳过它免一次整份重读。
    onSaved: (pluginId, event) =>
      broadcastToWindows(
        PLUGIN_DATA_CHANNELS.CHANGED,
        (win) => (win.webContents === event.sender ? SKIP_BROADCAST : { id: pluginId }),
        '[plugin-data] CHANGED',
      ),
  });
}
