// 插件本地 KV 存储(M-Plugin v2.3)。
// 生产实现走 IPC 写到 userData/plugins/<id>/data.json;
// InMemoryDataStore 继续适配测试与无文件系统场景。

import { coApi } from '@/lib/co-api';

export interface PluginDataStore {
  /** 返回 null 表示未写过该 id;抛错由调用方决定. */
  read(pluginId: string): Promise<unknown | null>;
  /** data 必须 JSON-serializable;序列化失败由实现抛错. */
  write(pluginId: string, data: unknown): Promise<void>;
}

export class InMemoryDataStore implements PluginDataStore {
  private map = new Map<string, unknown>();

  async read(pluginId: string): Promise<unknown | null> {
    return this.map.has(pluginId) ? (this.map.get(pluginId) ?? null) : null;
  }

  async write(pluginId: string, data: unknown): Promise<void> {
    // 走一遍 JSON 反复确保可序列化(不可序列化值早抛)
    JSON.stringify(data);
    this.map.set(pluginId, data);
  }
}

export class IpcPluginDataStore implements PluginDataStore {
  private cache = new Map<string, unknown>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<unknown | null>>();

  async read(pluginId: string): Promise<unknown | null> {
    if (this.loaded.has(pluginId)) {
      return this.cache.has(pluginId) ? (this.cache.get(pluginId) ?? null) : null;
    }
    const loaded = await this.load(pluginId);
    return loaded;
  }

  async write(pluginId: string, data: unknown): Promise<void> {
    JSON.stringify(data);
    this.cache.set(pluginId, data);
    this.loaded.add(pluginId);
    await coApi.pluginDataRaw.save(pluginId, { value: data });
  }

  private async load(pluginId: string): Promise<unknown | null> {
    const existing = this.loading.get(pluginId);
    if (existing) return existing;
    const promise = (async () => {
      const data = await coApi.pluginDataRaw.load(pluginId);
      const hasValue = Object.prototype.hasOwnProperty.call(data, 'value');
      if (hasValue) this.cache.set(pluginId, data['value']);
      this.loaded.add(pluginId);
      this.loading.delete(pluginId);
      return hasValue ? (data['value'] ?? null) : null;
    })();
    this.loading.set(pluginId, promise);
    return promise;
  }
}
