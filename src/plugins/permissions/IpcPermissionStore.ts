// IPC-backed PermissionStore(M-Plugin v4.2)。
// 替换 InMemoryPermissionStore,把决策写到 userData/plugins/_permissions.json。
//
// 内部 in-memory cache,首次 get 触发 IPC read 拉取;每次 grant/deny 写整盘
// (插件 / 权限 < 100 项,JSON 全写小成本可接受;不投资增量)。

import { coApi } from '@/lib/co-api';
import { runSerialPerKey } from '@/lib/serialize-per-key';
import {
  keepGrantedDecisions,
  replacePermissionDecisions,
  type PermissionDecision,
  type PermissionKey,
  type PermissionStore,
} from '../permissions';
import type { PathScope } from '../types';
import type {
  IpcPermissionRecord,
  IpcPermissionsMap,
} from '../../../electron/shared/plugins-channels';

export interface PermissionRecord {
  readonly decisions: PermissionDecision[];
  readonly pathScopes?: readonly PathScope[];
}

export type PermissionState = Record<string, PermissionRecord>;

// 可维护性 M6:序列化形态复用 shared 契约(IpcPermissionsMap = 旧数组 | 新
// { decisions, pathScopes? } union),不再本地另立 Serialized* 类型 + writePermissions
// 时 `as never` 强转。

type Cache = PermissionState;

const PATH_SCOPE_MODES = new Set(['r', 'rw']);

// 边界(E245,E215/E243 读端有界解析族):renderer 读回 READ_PERMISSIONS(IPC/磁盘持久化)的解析上限,
// 与主进程 plugins.ipc 写端 / plugins.service 读端对齐(值同步)。此前 parsePermissionState 直接
// Object.entries(raw) 全量物化 + parseDecisionList/parsePathScopes 无数量上限、无 permission/path 长度
// 校验、decidedAt 仅 typeof number(允许 Infinity/NaN)—— 畸形/未来回归的 IPC payload 在 renderer 首次
// 授权检查时扫描/分配巨表,并把超长 permission/path 或非有限时间戳缓进 cache,随后 grant/deny 写回。
// 读端独立有界:数量收集到上限即停 + 字段长度/有限性校验(写端 cap 护不了畸形/旧/篡改数据)。
const MAX_PERMISSION_PLUGIN_KEYS = 10_000; // 对齐 plugins.ipc PLUGINS_MAX
const MAX_DECISIONS_PER_PLUGIN = 1000; // 对齐 plugins.ipc DECISIONS_MAX
// 边界(E246):pathScopes 上限对齐**绑定** cap = 读盘层 MAX_PERSISTED_SCOPES_PER_PLUGIN(256,
// PathScopeRegistry 契约),非写端宽松值。E245 误对齐到写端 10_000;真正生效的是读盘 256,统一到此。
const MAX_PATH_SCOPES_PER_PLUGIN = 256; // 对齐 plugins.service MAX_PERSISTED_SCOPES_PER_PLUGIN / plugins.ipc PATHSCOPES_MAX
const PERMISSION_NAME_MAX = 256; // 对齐 plugins.ipc PERMISSION_MAX
const SCOPE_PATH_MAX = 8192; // 对齐 plugins.ipc PATH_MAX

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseDecision(value: unknown): PermissionDecision | null {
  if (!isRecord(value)) return null;
  if (typeof value.permission !== 'string') return null;
  if (value.permission.length > PERMISSION_NAME_MAX) return null; // 边界(E245)
  if (typeof value.granted !== 'boolean') return null;
  // 边界(E245,E92 写端对偶):decidedAt 须有限非负(typeof number 放行 Infinity/NaN;写端已 .finite()
  // .nonnegative(),读端对齐丢弃非有限/负时间戳,防脏值随 grant/deny 写回)。
  if (
    typeof value.decidedAt !== 'number' ||
    !Number.isFinite(value.decidedAt) ||
    value.decidedAt < 0
  ) {
    return null;
  }
  return {
    permission: value.permission as PermissionKey,
    granted: value.granted,
    decidedAt: value.decidedAt,
  };
}

function parsePathScope(value: unknown): PathScope | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== 'string') return null;
  if (value.path.length > SCOPE_PATH_MAX) return null; // 边界(E245)
  if (typeof value.mode !== 'string' || !PATH_SCOPE_MODES.has(value.mode)) {
    return null;
  }
  return { path: value.path, mode: value.mode as PathScope['mode'] };
}

function parseDecisionList(value: unknown): PermissionDecision[] {
  if (!Array.isArray(value)) return [];
  const out: PermissionDecision[] = [];
  for (const item of value) {
    if (out.length >= MAX_DECISIONS_PER_PLUGIN) break; // 边界(E245):数量上限早停
    const parsed = parseDecision(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parsePathScopes(value: unknown): PathScope[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const out: PathScope[] = [];
  for (const item of value) {
    if (out.length >= MAX_PATH_SCOPES_PER_PLUGIN) break; // 边界(E245):数量上限早停
    const parsed = parsePathScope(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parsePermissionState(raw: unknown): PermissionState {
  if (!isRecord(raw)) return {};
  const out: PermissionState = {};
  // 边界(E245):plugin 条目数上限 + for...in 早停(不 Object.entries 全量物化巨表)。
  let keyCount = 0;
  for (const pluginId in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, pluginId)) continue;
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

export function serializePermissionState(
  state: PermissionState,
): IpcPermissionsMap {
  const out: Record<string, IpcPermissionRecord> = {};
  for (const pluginId in state) {
    if (!Object.prototype.hasOwnProperty.call(state, pluginId)) continue;
    out[pluginId] = serializePermissionRecord(state[pluginId]!);
  }
  return out;
}

/** 单条记录序列化:无 pathScopes → 旧数组形态;有 → 新对象形态. */
export function serializePermissionRecord(
  record: PermissionRecord,
): IpcPermissionRecord {
  if (record.pathScopes === undefined) return record.decisions;
  return { decisions: record.decisions, pathScopes: record.pathScopes };
}

export class IpcPermissionStore implements PermissionStore {
  private cache: Cache | null = null;
  private loadingPromise: Promise<Cache> | null = null;
  // race(R15):per-plugin 变更串行链。grant/deny/clearDenied 是 read-cache→compute→write→commit
  // 的 RMW;同 plugin 两个并发变更若各从同一 cache 快照算整条 record 覆盖写(main 按 plugin 整条
  // 覆盖,不合并 decisions)→ 后完成者抹掉先完成者的决策(lost update,如 grant(['fs']) 与
  // deny(['shell']) 并发)。把整段 RMW 经此链串行,后一个变更读到前一个已提交的 cache。
  private chains = new Map<string, Promise<unknown>>();

  // race(R101):串行 + 排空回收收口到共享 runSerialPerKey(原 inline 副本漏删 key → chains 随
  // 变更过权限的不同 pluginId 单调增长内存泄漏)。语义不变:前次失败不阻断后续(链尾吞错)。
  private runExclusive<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    return runSerialPerKey(this.chains, pluginId, fn);
  }

  async get(pluginId: string): Promise<readonly PermissionDecision[]> {
    const cache = await this.ensureLoaded();
    return cache[pluginId]?.decisions ?? [];
  }

  async grant(
    pluginId: string,
    perms: readonly PermissionKey[],
  ): Promise<void> {
    await this.upsert(pluginId, perms, true);
  }

  async deny(
    pluginId: string,
    perms: readonly PermissionKey[],
  ): Promise<void> {
    await this.upsert(pluginId, perms, false);
  }

  async clearDenied(pluginId: string): Promise<void> {
    // race(R15):与 grant/deny 共用 per-plugin 链串行,避免并发 RMW 互相覆盖整条 record。
    return this.runExclusive(pluginId, async () => {
      const cache = await this.ensureLoaded();
      const record = cache[pluginId];
      if (!record) return;
      const kept = keepGrantedDecisions(record.decisions);
      const removeEntry = kept.length === 0 && record.pathScopes === undefined;
      // 空记录 → main 删除该 id 条目;否则保留 pathScopes,只去掉 denied decisions。
      const written: PermissionRecord = removeEntry
        ? { decisions: [] }
        : { ...record, decisions: kept };
      // 数据安全(codex 复查 P1,同 upsert):先写盘、成功后才改 cache,写失败抛(不只 warn)。
      // 否则写失败时 cache 进入半提交态 → 下次成功写持久化这次失败的清理、覆盖磁盘原决策。
      const r = await coApi.plugins.writePluginPermissions(
        pluginId,
        serializePermissionRecord(written),
      );
      if (!r.ok) {
        throw Object.assign(
          new Error(r.message ?? 'clearDenied writePluginPermissions failed'),
          { code: r.code },
        );
      }
      // 仅写成功后提交 cache
      if (removeEntry) delete cache[pluginId];
      else cache[pluginId] = written;
    });
  }

  // ── 内部 ──────────────────────────────────────────

  private async ensureLoaded(): Promise<Cache> {
    if (this.cache) return this.cache;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = (async () => {
      try {
        const r = await coApi.plugins.readPermissions();
        if (!r.ok) {
          // 数据安全(codex 复查 P1,main #20 的 renderer 对偶):读权限失败(EACCES/EIO
          // 经 main safeHandle → ok:false;ENOENT 首次启动仍是 ok:true 的 {})= 当前权限态
          // 未知。绝不缓存空表 —— 否则 grant/deny/clearDenied 基于 {} 做 RMW,用部分 record
          // 覆盖该 plugin 已落盘的 decisions/pathScopes(尤其丢已授 pathScopes)。抛出且不写
          // cache → 调用侧(get/grant/deny/clearDenied)fail-closed,不在未知态写。
          throw Object.assign(new Error(r.message ?? 'readPermissions failed'), {
            code: r.code,
          });
        }
        const data: Cache = parsePermissionState(r.data);
        this.cache = data;
        return data;
      } finally {
        // 数据安全(codex 复查 P2):loadingPromise 必须在**所有**结局清除 —— 不只 ok:false
        // /成功,还包括 readPermissions() 的 promise 自身 reject(桥/进程/通道瞬时异常)。
        // 否则该 rejected promise 被永久缓存,后续 get/grant/deny/clearDenied 复用它无法
        // 重试,本窗口权限态永久卡死直到刷新。finally 清空 → 下次调用重新发起读、可恢复。
        this.loadingPromise = null;
      }
    })();
    return this.loadingPromise;
  }

  private async upsert(
    pluginId: string,
    perms: readonly PermissionKey[],
    granted: boolean,
  ): Promise<void> {
    // race(R15):整段 RMW 经 per-plugin 链串行,后一个变更读到前一个已提交的 cache。
    return this.runExclusive(pluginId, async () => {
      const cache = await this.ensureLoaded();
      const existing = cache[pluginId];
      const existingDecisions = existing?.decisions ?? [];
      const updated = replacePermissionDecisions(
        existingDecisions,
        perms,
        granted,
        Date.now(),
      );
      const next: PermissionRecord = { ...existing, decisions: updated };
      // 数据安全(codex 复查 P1):**先写盘,确认成功后才提交 cache** —— 不在写确认前乐观改
      // cache,且写失败必须抛(不再只 warn)。否则磁盘写失败时 cache 进入未落盘半提交态:
      // (a) 调用方误以为已保存;(b) 下次成功写会基于半提交 cache 生成 record,把这次失败的
      // 变更一起持久化、覆盖磁盘原有决策,重启前后权限态不一致。按单 plugin 合并写。
      const r = await coApi.plugins.writePluginPermissions(
        pluginId,
        serializePermissionRecord(next),
      );
      if (!r.ok) {
        throw Object.assign(
          new Error(r.message ?? 'writePluginPermissions failed'),
          { code: r.code },
        );
      }
      cache[pluginId] = next; // 仅写成功后提交 cache
    });
  }
}
