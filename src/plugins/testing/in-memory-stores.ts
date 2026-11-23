// 测试替身:内存版 PermissionStore / PluginDataStore。生产只用 IpcPermissionStore / IpcPluginDataStore;
// 这里的实现只给测试(及 test-utils 的 createTestCoApp)用,不在生产代码路径上。

import type { PermissionDecision, PermissionKey, PermissionStore } from '../permissions';
import { serializeWithinLimit, type PluginDataStore } from '../PluginDataStore';

const EMPTY_PERMISSION_DECISIONS: PermissionDecision[] = [];

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
  if (list.length === 0) {
    const next = new Array<PermissionDecision>(perms.length);
    for (let i = 0; i < perms.length; i++) {
      next[i] = { permission: perms[i]!, granted, decidedAt };
    }
    return next;
  }
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

  forget(pluginId: string): void {
    this.map.delete(pluginId);
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

export class InMemoryDataStore implements PluginDataStore {
  private map = new Map<string, unknown>();

  async read(pluginId: string): Promise<unknown | null> {
    return this.map.get(pluginId) ?? null;
  }

  async write(pluginId: string, data: unknown): Promise<void> {
    // 走一遍 JSON 确保可序列化 + 大小上限(E43:与 IPC 实现同一上限,行为对齐)
    serializeWithinLimit(data);
    this.map.set(pluginId, data);
  }

  forget(pluginId: string): void {
    this.map.delete(pluginId);
  }
}
