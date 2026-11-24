import { ipcRenderer } from 'electron';
import { PLUGIN_DATA_CHANNELS } from '../shared/plugin-data-channels';
import { subscribeIpc } from './subscribe-ipc';

export interface PluginDataRaw {
  load(pluginId: string): Promise<Record<string, unknown>>;
  /** serializedValue = JSON.stringify(value);main 落盘 `{"value":...}`,load 返回 { value }。 */
  saveSerialized(pluginId: string, serializedValue: string): Promise<void>;
  /**
   * 订阅「某插件 data.json 已被别的窗口写入」广播,返 unsubscribe。payload 原样交出(unknown),
   * 由 renderer(wirePluginDataInvalidation)按 `{ id }` 守卫校验。
   */
  onChanged(cb: (payload: unknown) => void): () => void;
}

export const pluginDataRaw: PluginDataRaw = {
  load: (id) => ipcRenderer.invoke(PLUGIN_DATA_CHANNELS.LOAD, id),
  saveSerialized: (id, serializedValue) =>
    ipcRenderer.invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, id, serializedValue),
  onChanged: (cb) => subscribeIpc(PLUGIN_DATA_CHANNELS.CHANGED, (_event, payload: unknown) => cb(payload)),
};
