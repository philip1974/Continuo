// 插件权限系统(M-Plugin v3.3)。
// 声明式 manifest.permissions + 首次启用授权门 + 决策持久化。

// 可维护性 M8:权限枚举单一来源 —— union 从 PERMISSION_KEYS 常量派生,避免手写 union
// 与数组双重维护(新增权限只改这一处);manifest schema 直接 z.enum(PERMISSION_KEYS),
// 不再 `as unknown as [PermissionKey, ...]` 绕过 z.enum 的非空 tuple 要求。
export const PERMISSION_KEYS = [
  'fs',
  'network',
  'shell',
  'clipboard',
  /** v5 Phase 4:plugin 注册 MCP tool 给 Agent 用. */
  'mcp-tools',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * v5 Phase 1:plugin 调 fs/network/shell/clipboard 时若未授权,
 * scoped-app 抛此错让 plugin 优雅 try/catch。runtime gating 启用见 Phase 3。
 */
export class PermissionError extends Error {
  readonly code = 'PERMISSION_DENIED' as const;
  constructor(
    readonly permission: PermissionKey,
    message?: string,
  ) {
    // i18n(I11):默认 message 改英文(SDK/开发者面向,且经 run-contributed-action 展示给
    // 用户时不泄漏中文到 en/ko)。含权限名;调用方可传 message 覆盖。
    super(message ?? `Permission denied: ${permission}`);
    this.name = 'PermissionError';
  }
}

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

const EMPTY_PERMISSION_DECISIONS: PermissionDecision[] = [];
const EMPTY_PERMISSION_KEYS: readonly PermissionKey[] = [];

export function keepGrantedDecisions(
  list: readonly PermissionDecision[],
): PermissionDecision[] {
  if (list.length === 0) return EMPTY_PERMISSION_DECISIONS;
  let kept: PermissionDecision[] | null = null;
  let keptCount = 0;
  let droppedDenied = false;
  for (let i = 0; i < list.length; i++) {
    const decision = list[i]!;
    if (!decision.granted) {
      if (!droppedDenied) {
        droppedDenied = true;
        kept = new Array<PermissionDecision>(list.length);
        for (let j = 0; j < keptCount; j++) kept[j] = list[j]!;
      }
      continue;
    }
    if (droppedDenied) {
      kept![keptCount] = decision;
    }
    keptCount += 1;
  }
  if (!droppedDenied) return list as PermissionDecision[];
  if (keptCount === 0) return EMPTY_PERMISSION_DECISIONS;
  kept!.length = keptCount;
  return kept!;
}

export function replacePermissionDecisions(
  list: readonly PermissionDecision[],
  perms: readonly PermissionKey[],
  granted: boolean,
  decidedAt: number,
): PermissionDecision[] {
  if (perms.length === 0) return list as PermissionDecision[];
  const replacementPerms = new Set(perms);
  const next = new Array<PermissionDecision>(list.length + perms.length);
  let nextCount = 0;
  for (const decision of list) {
    if (!replacementPerms.has(decision.permission)) next[nextCount++] = decision;
  }
  for (const permission of perms) {
    next[nextCount++] = { permission, granted, decidedAt };
  }
  next.length = nextCount;
  return next;
}

export class InMemoryPermissionStore implements PermissionStore {
  private map = new Map<string, PermissionDecision[]>();

  async get(pluginId: string): Promise<readonly PermissionDecision[]> {
    return this.map.get(pluginId) ?? EMPTY_PERMISSION_DECISIONS;
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
    const kept = keepGrantedDecisions(list);
    if (kept.length === 0) this.map.delete(pluginId);
    else this.map.set(pluginId, kept);
  }

  private upsert(
    pluginId: string,
    perms: readonly PermissionKey[],
    granted: boolean,
  ): void {
    if (perms.length === 0) return;
    const list = this.map.get(pluginId) ?? EMPTY_PERMISSION_DECISIONS;
    const next = replacePermissionDecisions(list, perms, granted, Date.now());
    this.map.set(pluginId, next);
  }
}

export type PromptFn = (
  pluginId: string,
  pendingPerms: readonly PermissionKey[],
) => Promise<readonly PermissionKey[]>;

export type AuthorizeResult =
  | {
      ok: true;
      /** requested 中实际被授权的子集. */
      granted: readonly PermissionKey[];
      /** requested 中被拒的子集(可能为空 = 全授). */
      denied: readonly PermissionKey[];
    }
  | { ok: false; deniedPerms: readonly PermissionKey[] };

/**
 * 检查 / 拉起授权流程。
 *
 * v5 Phase 2 改造:**支持部分授权**。
 * - 全部 requested 都被拒 → ok=false(plugin 不激活,与 v4.7 行为一致)
 * - 只要至少一个 granted → ok=true,granted+denied 列表如实暴露
 * - 调用方据 denied.length>0 决定是否设 entry.warning(部分授权 badge)
 *
 * 待决项(既不 granted 也不 denied)调 prompt 收用户决策;已 denied 不再复 prompt。
 */
export async function ensureAuthorized(
  pluginId: string,
  requested: readonly PermissionKey[],
  store: PermissionStore,
  prompt: PromptFn,
): Promise<AuthorizeResult> {
  if (requested.length === 0) {
    return {
      ok: true,
      granted: EMPTY_PERMISSION_KEYS,
      denied: EMPTY_PERMISSION_KEYS,
    };
  }

  const decisions = await store.get(pluginId);
  if (decisions.length === 0) {
    const userGranted = await prompt(pluginId, requested);
    const userGrantedSet = new Set(userGranted);
    const granted = new Array<PermissionKey>(requested.length);
    const denied = new Array<PermissionKey>(requested.length);
    let grantedCount = 0;
    let deniedCount = 0;
    for (const p of requested) {
      if (userGrantedSet.has(p)) granted[grantedCount++] = p;
      else denied[deniedCount++] = p;
    }
    granted.length = grantedCount;
    denied.length = deniedCount;

    if (userGranted.length > 0) await store.grant(pluginId, userGranted);
    if (denied.length > 0) await store.deny(pluginId, denied);

    if (granted.length === 0) {
      return { ok: false, deniedPerms: denied };
    }
    return { ok: true, granted, denied };
  }

  const grantedSet = new Set<PermissionKey>();
  const deniedSet = new Set<PermissionKey>();
  for (const d of decisions) {
    if (d.granted) grantedSet.add(d.permission);
    else deniedSet.add(d.permission);
  }

  // 待决:既不在 granted 也不在 denied(尚未决策的项)
  const pending = new Array<PermissionKey>(requested.length);
  let pendingCount = 0;
  for (const p of requested) {
    if (!grantedSet.has(p) && !deniedSet.has(p)) pending[pendingCount++] = p;
  }
  pending.length = pendingCount;

  if (pending.length > 0) {
    const userGranted = await prompt(pluginId, pending);
    const userGrantedSet = new Set(userGranted);
    const newDeny = new Array<PermissionKey>(pending.length);
    let newDenyCount = 0;
    for (const p of pending) {
      if (!userGrantedSet.has(p)) newDeny[newDenyCount++] = p;
    }
    newDeny.length = newDenyCount;

    if (userGranted.length > 0) await store.grant(pluginId, userGranted);
    if (newDeny.length > 0) await store.deny(pluginId, newDeny);

    for (const p of userGranted) grantedSet.add(p);
    for (const p of newDeny) deniedSet.add(p);
  }

  const granted = new Array<PermissionKey>(requested.length);
  const denied = new Array<PermissionKey>(requested.length);
  let grantedCount = 0;
  let deniedCount = 0;
  for (const p of requested) {
    if (grantedSet.has(p)) granted[grantedCount++] = p;
    else if (deniedSet.has(p)) denied[deniedCount++] = p;
  }
  granted.length = grantedCount;
  denied.length = deniedCount;

  // 全拒(无任何 granted)→ status=failed,触发 v4.7 [启用] retry 路径
  if (granted.length === 0) {
    return { ok: false, deniedPerms: denied };
  }
  return { ok: true, granted, denied };
}
