// 插件本地 KV 存储(M-Plugin v2.3)。
// 生产实现走 IPC 写到 userData/plugins/<id>/data.json(待 v3 接);
// 当前默认 InMemoryDataStore,适配测试与无文件系统场景。

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
