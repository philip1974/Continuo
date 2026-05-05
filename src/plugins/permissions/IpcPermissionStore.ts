// IPC-backed PermissionStore(M-Plugin v4.2)。
// 替换 InMemoryPermissionStore,把决策写到 userData/plugins/_permissions.json。
//
// 内部 in-memory cache,首次 get 触发 IPC read 拉取;每次 grant/deny 写整盘
// (插件 / 权限 < 100 项,JSON 全写小成本可接受;不投资增量)。

import { lmApi } from '@/lib/lm-api';
import type {
  PermissionDecision,
  PermissionKey,
  PermissionStore,
} from '../permissions';

type Cache = Record<string, PermissionDecision[]>;

export class IpcPermissionStore implements PermissionStore {
  private cache: Cache | null = null;
  private loadingPromise: Promise<Cache> | null = null;

  async get(pluginId: string): Promise<readonly PermissionDecision[]> {
    const cache = await this.ensureLoaded();
    return cache[pluginId] ?? [];
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
    const list = cache[pluginId];
    if (!list) return;
    const kept = list.filter((d) => d.granted);
    if (kept.length === 0) delete cache[pluginId];
    else cache[pluginId] = kept;
    const r = await lmApi.plugins.writePermissions(cache);
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
      const r = await lmApi.plugins.readPermissions();
      const data: Cache = r.ok
        ? (Object.fromEntries(
            Object.entries(r.data).map(([pid, list]) => [
              pid,
              list.map((d) => ({
                permission: d.permission as PermissionKey,
                granted: d.granted,
                decidedAt: d.decidedAt,
              })),
            ]),
          ) as Cache)
        : {};
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
    const existing = cache[pluginId] ?? [];
    const filtered = existing.filter(
      (d) => !perms.includes(d.permission),
    );
    const now = Date.now();
    const updated: PermissionDecision[] = [
      ...filtered,
      ...perms.map((p) => ({ permission: p, granted, decidedAt: now })),
    ];
    cache[pluginId] = updated;
    const r = await lmApi.plugins.writePermissions(cache);
    if (!r.ok) {
      console.warn(
        '[IpcPermissionStore] writePermissions failed',
        r.code,
        r.message,
      );
    }
  }
}
