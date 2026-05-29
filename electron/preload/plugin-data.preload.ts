import { ipcRenderer } from 'electron';
import { PLUGIN_DATA_CHANNELS } from '../shared/plugin-data-channels';

export interface PluginDataRaw {
  load(pluginId: string): Promise<Record<string, unknown>>;
  save(pluginId: string, data: Record<string, unknown>): Promise<void>;
  clear(pluginId: string): Promise<void>;
}

export const pluginDataRaw: PluginDataRaw = {
  load: (id) => ipcRenderer.invoke(PLUGIN_DATA_CHANNELS.LOAD, id),
  save: (id, data) => ipcRenderer.invoke(PLUGIN_DATA_CHANNELS.SAVE, id, data),
  clear: (id) => ipcRenderer.invoke(PLUGIN_DATA_CHANNELS.CLEAR, id),
};
