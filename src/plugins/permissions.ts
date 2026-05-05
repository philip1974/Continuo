// 插件权限系统(M-Plugin v3.3)。
// 声明式 manifest.permissions + 首次启用授权门 + 决策持久化。

export type PermissionKey = 'fs' | 'network' | 'shell' | 'clipboard';

export const PERMISSION_KEYS: readonly PermissionKey[] = [
  'fs',
  'network',
  'shell',
  'clipboard',
];

export interface PermissionDecision {
  readonly permission: PermissionKey;
  readonly granted: boolean;
  readonly decidedAt: number;
}

export interface PermissionStore {
  get(pluginId: string): Promise<readonly PermissionDecision[]>;
  grant(pluginId: string, perms: readonly PermissionKey[]): Promise<void>;
  deny(pluginId: string, perms: readonly PermissionKey[]): Promise<void>;
  /** 移除该插件所有 granted=false 的决策(允许用户改主意,重启 prompt). */
  clearDenied(pluginId: string): Promise<void>;
}

export class InMemoryPermissionStore implements PermissionStore {
  private map = new Map<string, PermissionDecision[]>();

  async get(pluginId: string): Promise<readonly PermissionDecision[]> {
    return this.map.get(pluginId) ?? [];
  }

  async grant(pluginId: string, perms: readonly PermissionKey[]): Promise<void> {
    this.upsert(pluginId, perms, true);
  }

  async deny(pluginId: string, perms: readonly PermissionKey[]): Promise<void> {
    this.upsert(pluginId, perms, false);
  }

  async clearDenied(pluginId: string): Promise<void> {
    const list = this.map.get(pluginId);
    if (!list) return;
    const kept = list.filter((d) => d.granted);
    if (kept.length === 0) this.map.delete(pluginId);
    else this.map.set(pluginId, kept);
  }

  private upsert(
    pluginId: string,
    perms: readonly PermissionKey[],
    granted: boolean,
  ): void {
    const list = this.map.get(pluginId) ?? [];
    const next: PermissionDecision[] = list.filter(
      (d) => !perms.includes(d.permission),
    );
    const now = Date.now();
    for (const p of perms) next.push({ permission: p, granted, decidedAt: now });
    this.map.set(pluginId, next);
  }
}

export type PromptFn = (
  pluginId: string,
  pendingPerms: readonly PermissionKey[],
) => Promise<readonly PermissionKey[]>;

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; deniedPerms: readonly PermissionKey[] };

/**
 * 检查 / 拉起授权流程。已 deny 任一 → 直接 fail 不 prompt;待决调 prompt 收用户决策。
 */
export async function ensureAuthorized(
  pluginId: string,
  requested: readonly PermissionKey[],
  store: PermissionStore,
  prompt: PromptFn,
): Promise<AuthorizeResult> {
  if (requested.length === 0) return { ok: true };

  const decisions = await store.get(pluginId);
  const granted = new Set(
    decisions.filter((d) => d.granted).map((d) => d.permission),
  );
  const denied = new Set(
    decisions.filter((d) => !d.granted).map((d) => d.permission),
  );

  // 已 deny 任一 → 立即 fail(不 prompt 复授)
  const blocked = requested.filter((p) => denied.has(p));
  if (blocked.length > 0) return { ok: false, deniedPerms: blocked };

  const pending = requested.filter((p) => !granted.has(p));
  if (pending.length === 0) return { ok: true };

  const userGranted = await prompt(pluginId, pending);
  const userGrantedSet = new Set(userGranted);
  const newDeny = pending.filter((p) => !userGrantedSet.has(p));

  if (userGranted.length > 0) await store.grant(pluginId, userGranted);
  if (newDeny.length > 0) await store.deny(pluginId, newDeny);

  if (newDeny.length > 0) return { ok: false, deniedPerms: newDeny };
  return { ok: true };
}
