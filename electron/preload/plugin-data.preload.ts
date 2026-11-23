import { ipcRenderer } from 'electron';
import { PLUGIN_DATA_CHANNELS } from '../shared/plugin-data-channels';

export interface PluginDataRaw {
  load(pluginId: string): Promise<Record<string, unknown>>;
  /** serializedValue = JSON.stringify(value);main 落盘 `{"value":...}`,load 返回 { value }。 */
  saveSerialized(pluginId: string, serializedValue: string): Promise<void>;
}

export const pluginDataRaw: PluginDataRaw = {
  load: (id) => ipcRenderer.invoke(PLUGIN_DATA_CHANNELS.LOAD, id),
  saveSerialized: (id, serializedValue) =>
    ipcRenderer.invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, id, serializedValue),
};
