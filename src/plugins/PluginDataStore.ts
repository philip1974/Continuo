// 插件本地 KV 存储(M-Plugin v2.3)。
// 生产实现走 IPC 写到 userData/plugins/<id>/data.json;
// InMemoryDataStore 继续适配测试与无文件系统场景。

import { coApi } from '@/lib/co-api';
import { runSerialPerKey } from '@/lib/serialize-per-key';
import { MAX_PLUGIN_DATA_BYTES } from '../../electron/shared/plugin-data-limits';
import { assertJsonValue } from '../../electron/shared/assert-json-value';
import { utf8ByteLength } from '../../electron/shared/utf8-byte-length';
import { jsonByteLowerBoundExceeds } from '../../electron/shared/json-byte-budget';

// 边界(E43,E41/E42 同族 — renderer 在主进程 cap 前先构造大对象):write() 必须先 JSON.stringify
// 校验可序列化,但畸形/恶意插件传超大对象时该 stringify 已在 renderer 产生巨大字符串,且会跨 IPC
// 传给主进程(主进程 16MiB cap 来不及保护)。stringify 后立即按主进程同一上限(共享常量)预检:
// 超限直接抛,不发 IPC、不提交 cache。返回序列化结果给调用方复用(避免二次 stringify)。
function serializeWithinLimit(data: unknown): string {
  // 边界(E306,E305 reorder 同族 / 校验顺序 fail-fast):先廉价字节下界 fail-fast(早停于上限)再
  // assertJsonValue 全量遍历 —— 否则超 16MiB 但 shape 合法(≤assertJsonValue 1M/10万/256 上限)的 data
  // 会被 assertJsonValue 完整遍历后才被字节 cap 拒。jsonByteLowerBoundExceeds 对任意输入安全(E288),可先跑。
  if (jsonByteLowerBoundExceeds(data, MAX_PLUGIN_DATA_BYTES)) {
    throw new Error(`plugin data too large (> ${MAX_PLUGIN_DATA_BYTES})`);
  }
  // 边界(E103):JSON.stringify 会静默改写 NaN/Infinity→null、丢 undefined/function(不抛),
  // 不是「可序列化」校验。assertJsonValue 递归拒非 JSON 安全值(避免静默持久化损坏),再 stringify。
  assertJsonValue(data);
  const serialized = JSON.stringify(data);
  // 边界(E125):真实 UTF-8 字节(非 .length=UTF-16 code unit),与主进程 store 同款。
  const dataBytes = utf8ByteLength(serialized);
  if (dataBytes > MAX_PLUGIN_DATA_BYTES) {
    throw new Error(
      `plugin data too large (${dataBytes} > ${MAX_PLUGIN_DATA_BYTES})`,
    );
  }
  return serialized;
}

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
    // 走一遍 JSON 确保可序列化 + 大小上限(E43:与 IPC 实现同一上限,行为对齐)
    serializeWithinLimit(data);
    this.map.set(pluginId, data);
  }
}

export class IpcPluginDataStore implements PluginDataStore {
  private cache = new Map<string, unknown>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<unknown | null>>();
  // race(R11):per-plugin 写代际。read() 触发的 load IPC 在途期间若发生 write(),旧 load 返回时
  // 不得用过期磁盘快照回滚 cache —— write 已写入更新值。load 捕获起始 gen,返回时若 gen 已变
  // (期间有 write 落地)则丢弃磁盘结果、返回 cache 当前值。
  private writeGen = new Map<string, number>();
  // race(R61):同一 pluginId 的 write 串行链。并发 write(A)、write(B) 时主进程 lock 只保证文件
  // 不损坏、不保证调用顺序;且 cache 提交按各自 save 的 resolve 顺序进行。若 B(后发)的 save 先
  // resolve、A(先发)的后 resolve,cache 最终回到 A(旧值)= lost update,重启后读到过期数据。
  // 按 pluginId 串行 save→writeGen++→cache commit 整段,保证「后发起者最后落地」。
  private writeChains = new Map<string, Promise<unknown>>();

  async read(pluginId: string): Promise<unknown | null> {
    if (this.loaded.has(pluginId)) {
      return this.cache.has(pluginId) ? (this.cache.get(pluginId) ?? null) : null;
    }
    const loaded = await this.load(pluginId);
    return loaded;
  }

  async write(pluginId: string, data: unknown): Promise<void> {
    // 序列化校验 + 大小上限(E43)放串行链外:非可序列化值/超限值早抛给调用方,不发 IPC、
    // 不占用/不污染写链、不提交 cache。renderer 侧预检挡主进程 16MiB cap 之前的前置放大。
    serializeWithinLimit(data);
    // race(R61):按 pluginId 串行整段 save→writeGen++→cache commit,保证并发 write 按调用顺序
    // 落地(后发起者最后提交),消除「后发写被先发但 save 迟到者覆盖」的 lost update。
    await runSerialPerKey(this.writeChains, pluginId, async () => {
      // 先落盘成功才认为已持久化:若 IPC save reject(磁盘满 / userData 只读 /
      // IPC 关闭中),不能把新值留在缓存 + 标 loaded —— 否则后续 read() 命中
      // loaded 分支返回这个从未落盘的值,让插件误以为保存成功(实则重启后丢失),
      // 即便插件 catch 了本次异常也无法在重试时察觉真实状态。失败时缓存保持旧值 /
      // 未加载态,read() 反映真实磁盘态。
      await coApi.pluginDataRaw.save(pluginId, { value: data });
      // race(R11):落盘成功后递增写代际并更新 cache —— 让在途的旧 load 返回时能检测到「期间有
      // 更新的 write 落地」从而不回滚 cache。
      this.writeGen.set(pluginId, (this.writeGen.get(pluginId) ?? 0) + 1);
      this.cache.set(pluginId, data);
      this.loaded.add(pluginId);
    });
  }

  private async load(pluginId: string): Promise<unknown | null> {
    const existing = this.loading.get(pluginId);
    if (existing) return existing;
    const startGen = this.writeGen.get(pluginId) ?? 0;
    const promise = (async () => {
      try {
        const data = await coApi.pluginDataRaw.load(pluginId);
        // race(R11):load 期间发生过 write(代际变化)→ 磁盘快照已过期,write 已把 cache 设为
        // 更新值;不回滚 cache,返回 cache 当前值(避免 stale read/write lost update)。
        if ((this.writeGen.get(pluginId) ?? 0) !== startGen) {
          this.loaded.add(pluginId);
          return this.cache.has(pluginId)
            ? (this.cache.get(pluginId) ?? null)
            : null;
        }
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
