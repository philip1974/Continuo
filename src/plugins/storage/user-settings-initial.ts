// 设置值 / 快捷键覆盖的首帧来源(主进程同步快照 / 待迁移时的旧 localStorage 记录)。独立成小模块:入口模块(main.tsx →
// theme/initial-theme)首帧前同步读主题时引用它,不把 store / 通知 / 错误码等拉进入口 chunk。读写与同步见 user-settings-record.ts。
// BDD: src/__tests__/user-settings-main-store/
import { coApi } from '@/lib/co-api';
import type { UserSettingsScope, UserSettingsSnapshot } from '../../../electron/shared/user-settings';
import type { ContinuoApi } from '../../../electron/preload';
import { readRecord } from './local-storage-record';

export type UserSettingsHost = ContinuoApi['userSettings'];

export function userSettingsHost(): UserSettingsHost | null {
  try {
    return (coApi.userSettings as UserSettingsHost | undefined) ?? null;
  } catch {
    return null; // 无 preload(单测 / 早期)
  }
}

/** main 的当前快照(同步);无 main / 不受信 → null。 */
export function readUserSettingsSnapshot(): UserSettingsSnapshot | null {
  try {
    return userSettingsHost()?.snapshot() ?? null;
  } catch {
    return null;
  }
}

/**
 * 首帧用的原始记录(未经 store 的值规整):有 main 快照且已迁移 → 快照;需要迁移 / 无 main → 旧 localStorage 记录。
 * 入口模块(initial-theme)与 store 初始化同一来源。
 */
export function initialUserSettingsRecord(
  scope: UserSettingsScope,
  legacyKey: string,
  snapshot: UserSettingsSnapshot | null = readUserSettingsSnapshot(),
): Record<string, unknown> {
  const s = snapshot?.[scope];
  if (s && !s.needsImport) return s.record;
  return readRecord<unknown>(legacyKey, { maxEntries: 10_000, maxKeyLength: 256 });
}
