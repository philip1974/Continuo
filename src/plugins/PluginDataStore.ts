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
    // 先落盘成功才认为已持久化:若 IPC save reject(磁盘满 / userData 只读 /
    // IPC 关闭中),不能把新值留在缓存 + 标 loaded —— 否则后续 read() 命中
    // loaded 分支返回这个从未落盘的值,让插件误以为保存成功(实则重启后丢失),
    // 即便插件 catch 了本次异常也无法在重试时察觉真实状态。失败时缓存保持旧值 /
    // 未加载态,read() 反映真实磁盘态。
    await coApi.pluginDataRaw.save(pluginId, { value: data });
    this.cache.set(pluginId, data);
    this.loaded.add(pluginId);
  }

  private async load(pluginId: string): Promise<unknown | null> {
    const existing = this.loading.get(pluginId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const data = await coApi.pluginDataRaw.load(pluginId);
        const hasValue = Object.prototype.hasOwnProperty.call(data, 'value');
        if (hasValue) this.cache.set(pluginId, data['value']);
        this.loaded.add(pluginId);
        return hasValue ? (data['value'] ?? null) : null;
      } finally {
        // reject 路径也必须清 loading:否则 rejected promise 永久留在 map 里,
        // 该 id 后续 read() 命中 `existing` 返回同一个已 reject 的 promise →
        // 瞬时 IPC 错误(主进程尚未就绪 / 临时失败)后永远无法重试,直到整页刷新。
        this.loading.delete(pluginId);
      }
    })();
    this.loading.set(pluginId, promise);
    return promise;
  }
}
