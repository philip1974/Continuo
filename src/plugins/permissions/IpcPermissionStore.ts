// IPC-backed PermissionStore(M-Plugin v4.2)。
// 替换 InMemoryPermissionStore,把决策写到 userData/plugins/_permissions.json。
//
// 内部 in-memory cache,首次 get 触发 IPC read 拉取;每次 grant/deny 写整盘
// (插件 / 权限 < 100 项,JSON 全写小成本可接受;不投资增量)。

import { coApi } from '@/lib/co-api';
import type {
  PermissionDecision,
  PermissionKey,
  PermissionStore,
} from '../permissions';
import type { PathScope } from '../types';

export interface PermissionRecord {
  readonly decisions: PermissionDecision[];
  readonly pathScopes?: readonly PathScope[];
}

export type PermissionState = Record<string, PermissionRecord>;

type SerializedPermissionRecord =
  | readonly PermissionDecision[]
  | {
      readonly decisions: readonly PermissionDecision[];
      readonly pathScopes?: readonly PathScope[];
    };

type SerializedPermissionState = Record<string, SerializedPermissionRecord>;

type Cache = PermissionState;

const PATH_SCOPE_MODES = new Set(['r', 'rw']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseDecision(value: unknown): PermissionDecision | null {
  if (!isRecord(value)) return null;
  if (typeof value.permission !== 'string') return null;
  if (typeof value.granted !== 'boolean') return null;
  if (typeof value.decidedAt !== 'number') return null;
  return {
    permission: value.permission as PermissionKey,
    granted: value.granted,
    decidedAt: value.decidedAt,
  };
}

function parsePathScope(value: unknown): PathScope | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== 'string') return null;
  if (typeof value.mode !== 'string' || !PATH_SCOPE_MODES.has(value.mode)) {
    return null;
  }
  return { path: value.path, mode: value.mode as PathScope['mode'] };
}

function parseDecisionList(value: unknown): PermissionDecision[] {
  if (!Array.isArray(value)) return [];
  const out: PermissionDecision[] = [];
  for (const item of value) {
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
    const parsed = parsePathScope(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parsePermissionState(raw: unknown): PermissionState {
  if (!isRecord(raw)) return {};
  const out: PermissionState = {};
  for (const [pluginId, record] of Object.entries(raw)) {
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
): SerializedPermissionState {
  const out: SerializedPermissionState = {};
  for (const [pluginId, record] of Object.entries(state)) {
    if (record.pathScopes === undefined) {
      out[pluginId] = record.decisions;
      continue;
    }
    out[pluginId] = {
      decisions: record.decisions,
      pathScopes: record.pathScopes,
    };
  }
  return out;
}

export class IpcPermissionStore implements PermissionStore {
  private cache: Cache | null = null;
  private loadingPromise: Promise<Cache> | null = null;

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
    const cache = await this.ensureLoaded();
    const record = cache[pluginId];
    if (!record) return;
    const kept = record.decisions.filter((d) => d.granted);
    if (kept.length === 0 && record.pathScopes === undefined) {
      delete cache[pluginId];
    } else {
      cache[pluginId] = { ...record, decisions: kept };
    }
    const r = await coApi.plugins.writePermissions(
      serializePermissionState(cache) as never,
    );
    if (!r.ok) {
      console.warn(
        '[IpcPermissionStore] clearDenied writePermissions failed',
        r.code,
        r.message,
      );
    }
  }

  // ── 内部 ──────────────────────────────────────────

  private async ensureLoaded(): Promise<Cache> {
    if (this.cache) return this.cache;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = (async () => {
      const r = await coApi.plugins.readPermissions();
      const data: Cache = r.ok ? parsePermissionState(r.data) : {};
      this.cache = data;
      this.loadingPromise = null;
      return data;
    })();
    return this.loadingPromise;
  }

  private async upsert(
    pluginId: string,
    perms: readonly PermissionKey[],
    granted: boolean,
  ): Promise<void> {
    const cache = await this.ensureLoaded();
    const existing = cache[pluginId];
    const existingDecisions = existing?.decisions ?? [];
    const filtered = existingDecisions.filter(
      (d) => !perms.includes(d.permission),
    );
    const now = Date.now();
    const updated: PermissionDecision[] = [
      ...filtered,
      ...perms.map((p) => ({ permission: p, granted, decidedAt: now })),
    ];
    cache[pluginId] = { ...existing, decisions: updated };
    const r = await coApi.plugins.writePermissions(
      serializePermissionState(cache) as never,
    );
    if (!r.ok) {
      console.warn(
        '[IpcPermissionStore] writePermissions failed',
        r.code,
        r.message,
      );
    }
  }
}
