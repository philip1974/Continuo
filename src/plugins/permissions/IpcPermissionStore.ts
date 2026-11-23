// IPC-backed PermissionStore(M-Plugin v4.2)。
// 替换 InMemoryPermissionStore,把决策写到 userData/plugins/_permissions.json。
//
// 内部 in-memory cache,首次 get 触发 IPC read 拉取;grant/deny/clearDenied 只发增量变更,
// main 合并当前落盘记录后返回合并结果(终审 P1);main 广播授权变更 → invalidate 整表重载。

import { coApi } from '@/lib/co-api';
import { PERMISSION_RECORD_LIMITS } from '../../../electron/shared/permission-record-limits';
import { runSerialPerKey } from '@/lib/serialize-per-key';
import type {
  PermissionDecision,
  PermissionKey,
  PermissionStore,
} from '../permissions';
import type { PathScope } from '../types';
import type { IpcPermissionMutation } from '../../../electron/shared/plugins-channels';
import {
  isIpcPathScope,
  isIpcPermissionDecision,
} from '../../../electron/shared/permission-record';
import { codedError } from '../../../electron/shared/error-message';
import { ownValue } from '../../../electron/shared/own-value';
import { isValidPluginId } from '../plugin-id';

export interface PermissionRecord {
  readonly decisions: PermissionDecision[];
  readonly pathScopes?: readonly PathScope[];
}

export type PermissionState = Record<string, PermissionRecord>;

// 可维护性 M6:序列化形态复用 shared 契约(IpcPermissionsMap = 旧数组 | 新
// { decisions, pathScopes? } union),不再本地另立 Serialized* 类型 + writePermissions
// 时 `as never` 强转。

type Cache = PermissionState;


// 边界(E245,E215/E243 读端有界解析族):renderer 读回 READ_PERMISSIONS(IPC/磁盘持久化)的解析上限,
// 与主进程 plugins.ipc 写端 / plugins.service 读端对齐(值同步)。此前 parsePermissionState 直接
// Object.entries(raw) 全量物化 + parseDecisionList/parsePathScopes 无数量上限、无 permission/path 长度
// 校验、decidedAt 仅 typeof number(允许 Infinity/NaN)—— 畸形/未来回归的 IPC payload 在 renderer 首次
// 授权检查时扫描/分配巨表,并把超长 permission/path 或非有限时间戳缓进 cache,随后 grant/deny 写回。
// 读端独立有界:数量收集到上限即停 + 字段长度/有限性校验(写端 cap 护不了畸形/旧/篡改数据)。
const MAX_PERMISSION_PLUGIN_KEYS = PERMISSION_RECORD_LIMITS.PLUGIN_KEYS_MAX;
const MAX_DECISIONS_PER_PLUGIN = PERMISSION_RECORD_LIMITS.DECISIONS_PER_PLUGIN_MAX; // 对齐 plugins.ipc DECISIONS_MAX
// 边界(E246):pathScopes 上限对齐**绑定** cap = 读盘层 MAX_PERSISTED_SCOPES_PER_PLUGIN(256,
// PathScopeRegistry 契约),非写端宽松值。E245 误对齐到写端 10_000;真正生效的是读盘 256,统一到此。
const MAX_PATH_SCOPES_PER_PLUGIN = PERMISSION_RECORD_LIMITS.PATH_SCOPES_PER_PLUGIN_MAX; // 对齐 plugins.service MAX_PERSISTED_SCOPES_PER_PLUGIN / plugins.ipc PATHSCOPES_MAX
const EMPTY_PERMISSION_DECISIONS: PermissionDecision[] = [];
// 读取期间被失效时按当前代际重读的总次数上限(终审 P1,见 ensureLoaded)。
const MAX_READ_ATTEMPTS = 3;
const EMPTY_PATH_SCOPES: PathScope[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 单条形态判定取 shared 单一来源(与 main 读盘 / 写盘、IPC schema 同一规则:permission 必须是枚举成员、
// decidedAt 有限非负、path 非空限长)。此处只负责把合法项重建成干净对象(丢弃额外字段)。
function parseDecision(value: unknown): PermissionDecision | null {
  if (!isIpcPermissionDecision(value)) return null;
  return {
    permission: value.permission as PermissionKey,
    granted: value.granted,
    decidedAt: value.decidedAt,
  };
}

function parsePathScope(value: unknown): PathScope | null {
  if (!isIpcPathScope(value)) return null;
  return { path: value.path, mode: value.mode };
}

function parseDecisionList(value: unknown): PermissionDecision[] {
  if (!Array.isArray(value)) return EMPTY_PERMISSION_DECISIONS;
  let out: PermissionDecision[] | null = null;
  let outCount = 0;
  for (const item of value) {
    if (outCount >= MAX_DECISIONS_PER_PLUGIN) break; // 边界(E245):数量上限早停
    const parsed = parseDecision(item);
    if (!parsed) continue;
    out ??= new Array<PermissionDecision>(
      Math.min(value.length, MAX_DECISIONS_PER_PLUGIN),
    );
    out[outCount++] = parsed;
  }
  if (out === null) return EMPTY_PERMISSION_DECISIONS;
  out.length = outCount;
  return out;
}

function parsePathScopes(value: unknown): PathScope[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return EMPTY_PATH_SCOPES;
  let out: PathScope[] | null = null;
  let outCount = 0;
  for (const item of value) {
    if (outCount >= MAX_PATH_SCOPES_PER_PLUGIN) break; // 边界(E245):数量上限早停
    const parsed = parsePathScope(item);
    if (!parsed) continue;
    out ??= new Array<PathScope>(
      Math.min(value.length, MAX_PATH_SCOPES_PER_PLUGIN),
    );
    out[outCount++] = parsed;
  }
  if (out === null) return EMPTY_PATH_SCOPES;
  out.length = outCount;
  return out;
}

export function parsePermissionState(raw: unknown): PermissionState {
  if (!isRecord(raw)) return {};
  const out: PermissionState = {};
  // 边界(E245):plugin 条目数上限 + for...in 早停(不 Object.entries 全量物化巨表)。
  let keyCount = 0;
  for (const pluginId in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, pluginId)) continue;
    // 安全:key 来自磁盘 JSON,非法 id(如 `__proto__`,首字符 `_`)写入 `out[pluginId]` 会改写结果对象原型。
    // 与主进程 readPermissions 读端同规则:非法 id 跳过且不计数。
    if (!isValidPluginId(pluginId)) continue;
    if (keyCount >= MAX_PERMISSION_PLUGIN_KEYS) break;
    keyCount += 1;
    const record: unknown = (raw as Record<string, unknown>)[pluginId];
    if (Array.isArray(record)) {
      out[pluginId] = { decisions: parseDecisionList(record) };
      continue;
    }
    if (isRecord(record)) {
      const pathScopes = parsePathScopes(record.pathScopes);
      out[pluginId] = {
        decisions: parseDecisionList(record.decisions),
        ...(pathScopes === undefined ? {} : { pathScopes }),
      };
    }
  }
  return out;
}

export class IpcPermissionStore implements PermissionStore {
  private cache: Cache | null = null;
  private loadingPromise: Promise<Cache> | null = null;
  // 终审 P1:失效代数。invalidate 递增;加载开始时的代数与完成时不一致 → 结果不落 cache(可能是变更前快照)。
  private generation = 0;
  private loadingGeneration = -1;
  // race(R15):per-plugin 变更串行链。同 plugin 并发 grant/deny/clearDenied 经此链串行,
  // 后一个变更的缓存提交不会被前一个迟到的提交覆盖。
  // race(R101):每插件的变更串行链,串行 + 排空回收由共享 runSerialPerKey 负责(前次失败不阻断后续)。
  private chains = new Map<string, Promise<unknown>>();
  // 加载在途时被 forget 的插件:读到的可能是卸载前的快照,落 cache 前剔除(见 forget)。
  private forgetOnLoad = new Set<string>();

  async get(pluginId: string): Promise<readonly PermissionDecision[]> {
    const cache = await this.ensureLoaded();
    // 只认自有属性:插件 id `constructor` 合法,普通对象缓存上会命中 Object 构造函数。
    return ownValue(cache, pluginId)?.decisions ?? EMPTY_PERMISSION_DECISIONS;
  }

  async grant(
    pluginId: string,
    perms: readonly PermissionKey[],
  ): Promise<void> {
    if (perms.length === 0) return;
    await this.mutate(pluginId, { kind: 'set', perms, granted: true });
  }

  async deny(
    pluginId: string,
    perms: readonly PermissionKey[],
  ): Promise<void> {
    if (perms.length === 0) return;
    await this.mutate(pluginId, { kind: 'set', perms, granted: false });
  }

  async clearDenied(pluginId: string): Promise<void> {
    // 本窗口缓存里没有拒绝项 → 不发 IPC(启用重试的常见路径)。别窗的变更经 plugins:permissions-changed
    // 广播失效本缓存;真正的清理由 main 按当前落盘记录执行。
    const cache = await this.ensureLoaded();
    const record = ownValue(cache, pluginId);
    if (!record || !record.decisions.some((d) => !d.granted)) return;
    await this.mutate(pluginId, { kind: 'clear-denied' });
  }

  /**
   * 插件已卸载(终审 P1:跨窗口卸载广播):丢弃该插件的内存决策,之后 get 返回空 → scoped app 的权限检查
   * 不再放行。main 卸载时已清 _permissions.json,这里不写盘。加载在途 → 加载结果落 cache 前同样剔除。
   */
  forget(pluginId: string): void {
    if (this.cache) delete this.cache[pluginId];
    if (this.loadingPromise) this.forgetOnLoad.add(pluginId);
  }

  /**
   * 插件授权已变更(终审 P1:main 广播 plugins:permissions-changed,含本窗口发起的变更):丢弃缓存,
   * 下次读重新从 main 加载。否则 A 窗口撤销后,B 窗口禁用再启用 / permission.check 仍按陈旧缓存放行。
   * 整表重载而非按 id 局部刷新:权限表很小,且只有 readPermissions 一份读契约。
   */
  invalidate(): void {
    this.generation += 1;
    this.cache = null;
  }

  // ── 内部 ──────────────────────────────────────────

  private async ensureLoaded(): Promise<Cache> {
    if (this.cache) return this.cache;
    // 在途加载若发起于最近一次 invalidate 之前,结果可能是变更前快照 → 不复用,重新发起。
    if (this.loadingPromise && this.loadingGeneration === this.generation) {
      return this.loadingPromise;
    }
    let generation = this.generation;
    this.loadingGeneration = generation;
    // 本次加载仍是登记中的那个(未被更新代数的加载接手);只有登记者在结束时清 loadingPromise。
    let registered = true;
    this.loadingPromise = (async () => {
      try {
        for (let attempt = 1; ; attempt += 1) {
          const r = await coApi.plugins.readPermissions();
          if (!r.ok) {
            // 数据安全(复查 P1,main #20 的 renderer 对偶):读权限失败(EACCES/EIO
            // 经 main safeHandle → ok:false;ENOENT 首次启动仍是 ok:true 的 {})= 当前权限态
            // 未知。绝不缓存空表 —— 抛出且不写 cache → 调用侧(get/grant/deny/clearDenied)
            // fail-closed,不在未知态写。
            throw codedError(r.code, r.message);
          }
          // 终审 P1:加载期间收到失效广播 → 读到的可能是撤销前快照,不落 cache 也不交给等待者(否则 ensurePerm
          // 放行一次),按当前代际重新读取;代际始终不稳定时有上限,超限视为读取失败(调用侧 fail-closed)。
          if (generation !== this.generation) {
            if (attempt >= MAX_READ_ATTEMPTS) {
              throw new Error('readPermissions: permissions kept changing during read');
            }
            // 仍是登记中的加载(无更新代数的加载接手)→ 随之换代,后来的调用方复用本次重读。
            registered &&= this.loadingGeneration === generation;
            generation = this.generation;
            if (registered) this.loadingGeneration = generation;
            continue;
          }
          const data: Cache = parsePermissionState(r.data);
          for (const id of this.forgetOnLoad) delete data[id];
          this.cache = data;
          return data;
        }
      } finally {
        // 数据安全(复查 P2):loadingPromise 必须在**所有**结局清除 —— 不只 ok:false
        // /成功,还包括 readPermissions() 的 promise 自身 reject(桥/进程/通道瞬时异常)。
        // 否则该 rejected promise 被永久缓存,后续调用复用它无法重试,本窗口权限态永久卡死。
        // 只清自己:失效后可能已有更新代数的加载在途(同一代数至多一个加载)。
        if (registered && this.loadingGeneration === generation) {
          this.loadingPromise = null;
          this.forgetOnLoad.clear();
        }
      }
    })();
    return this.loadingPromise;
  }

  /**
   * 终审 P1:只把本次变更的权限项发给 main,由 main 在串行写链内合并当前落盘记录(不再发整条记录覆盖写 ——
   * 陈旧缓存算出的整条记录会把别窗的撤销写回)。以 main 返回的合并结果更新本插件缓存。
   */
  private mutate(
    pluginId: string,
    mutation: IpcPermissionMutation,
  ): Promise<void> {
    return runSerialPerKey(this.chains, pluginId, async () => {
      // 读失败(未知态)→ 抛,不写(fail-closed,既有契约)。
      await this.ensureLoaded();
      const r = await coApi.plugins.mutatePluginPermissions(pluginId, mutation);
      // 数据安全(复查 P1):写失败必须抛(不只 warn),且不改 cache(写确认后才提交)。
      if (!r.ok) {
        throw codedError(r.code, r.message);
      }
      // 期间已被 invalidate(cache=null)→ 下次读从 main 重新加载,无需提交。
      const cache = this.cache;
      if (!cache) return;
      const merged =
        r.data === null
          ? undefined
          : parsePermissionState({ [pluginId]: r.data })[pluginId];
      if (merged) cache[pluginId] = merged;
      else delete cache[pluginId];
    });
  }
}
