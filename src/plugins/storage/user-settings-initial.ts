// 设置值 / 快捷键覆盖的首帧来源(主进程同步快照 / 待迁移时的旧 localStorage 记录)。独立成小模块:入口模块(main.tsx →
// theme/initial-theme)首帧前同步读主题时引用它,不把 store / 通知 / 错误码等拉进入口 chunk。读写与同步见 user-settings-record.ts。
// BDD: src/__tests__/user-settings-main-store/
import { coApi } from '@/lib/co-api';
import type { UserSettingsScope, UserSettingsSnapshot } from '../../../electron/shared/user-settings';
import type { ContinuoApi } from '../../../electron/preload';
import { ownValue, setOwnValue } from '../../../electron/shared/own-value';
import { constrainRecord, getLocalStorage, readRecord, type ReadRecordOptions } from './local-storage-record';

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

// ── 旧版本(0.2.15,设置存 localStorage)的双向兼容 ─────────────────────────────────────────────────────────
// 权威始终是主进程文件;旧 localStorage 键只是给降级后的旧版本看的镜像。每次拿到权威新状态,把它(旧 id)写回旧键,同时在
// `<旧键>.mirror` 记下写进去的原文。旧版本只改旧键、不认识 .mirror:启动时两者不同 = 降级期间旧版本改过 → 把它改动的条目
// (相对镜像的差异)并进文件;相同 = 旧版本没动过(文件被删时不回灌旧值,= 恢复默认,同 VSCode 删 settings.json);
// 从未镜像过(首次从旧版本升级)才把旧记录整份迁入。两个键在同一任务里先后写,同批落盘;镜像丢了(强杀)只会让旧版本看到
// 稍旧的值,不影响文件里的权威值。BDD: src/__tests__/user-settings-main-store/(legacy-mirror.spec.ts)

/** 镜像原文的 localStorage 键。 */
export const legacyMirrorKey = (legacyKey: string): string => `${legacyKey}.mirror`;

/** 同 readRecord 的原始串上限:超过的镜像旧版本也读不回来,不写。 */
const LEGACY_MIRROR_MAX_RAW_LENGTH = 1024 * 1024;

/** next 相对 prev 的差异(要设的与要删的)。 */
export function diffRecords<V>(prev: Record<string, V>, next: Record<string, V>): { set: Record<string, V>; remove: string[] } {
  const set: Record<string, V> = {};
  const remove: string[] = [];
  for (const k in next) {
    if (Object.prototype.hasOwnProperty.call(next, k) && !Object.is(ownValue(prev, k), next[k])) setOwnValue(set, k, next[k]!);
  }
  for (const k in prev) {
    if (Object.prototype.hasOwnProperty.call(prev, k) && !Object.hasOwn(next, k)) remove.push(k);
  }
  return { set, remove };
}

export interface LegacyChanges<V> {
  /** 旧键当前的记录(按 opts 规整)。 */
  readonly legacy: Record<string, V>;
  /** 是否镜像过(否 = 首次从旧版本升级)。 */
  readonly mirrored: boolean;
  /** 镜像之后旧版本改动的条目(旧 id;未镜像过 / 没改动 → 空)。 */
  readonly set: Record<string, V>;
  readonly remove: string[];
}

/** 读旧键与镜像,算出旧版本在上次镜像之后的改动。 */
export function readLegacyChanges<V>(legacyKey: string, opts: ReadRecordOptions<V>): LegacyChanges<V> {
  const st = getLocalStorage();
  let legacyRaw: string | null = null;
  let mirrorRaw: string | null = null;
  try {
    legacyRaw = st?.getItem(legacyKey) ?? null;
    mirrorRaw = st?.getItem(legacyMirrorKey(legacyKey)) ?? null;
  } catch {
    // localStorage 不可用:当作从未镜像、无旧记录
  }
  const legacy = readRecord<V>(legacyKey, opts);
  // 旧键整个没了(旧版本发现它损坏清掉 / 被外部清理)不当成「旧版本删光了所有设置」。
  if (mirrorRaw === null || legacyRaw === null || legacyRaw === mirrorRaw) {
    return { legacy, mirrored: mirrorRaw !== null, set: {}, remove: [] };
  }
  let mirrorParsed: unknown;
  try {
    mirrorParsed = JSON.parse(mirrorRaw);
  } catch {
    mirrorParsed = null;
  }
  const mirror = constrainRecord<V>(mirrorParsed, opts);
  if (mirror === null) return { legacy, mirrored: false, set: {}, remove: [] }; // 镜像本身坏了:不推断改动
  return { legacy, mirrored: true, ...diffRecords(mirror, legacy) };
}

/** 把旧版本的改动(旧 id)应用到记录上:`legacyIds` 旧 id → 新 id(设 / 删都落到新 id)。改动为空时返回原对象。 */
export function applyLegacyChanges<V>(
  record: Record<string, V>,
  changes: Pick<LegacyChanges<V>, 'set' | 'remove'>,
  legacyIds: Readonly<Record<string, string>> = {},
): Record<string, V> {
  const setKeys = Object.keys(changes.set);
  if (setKeys.length === 0 && changes.remove.length === 0) return record;
  const next = { ...record };
  const idOf = (k: string): string => (Object.hasOwn(legacyIds, k) ? legacyIds[k]! : k);
  for (const k of changes.remove) delete next[idOf(k)];
  for (const k of setKeys) setOwnValue(next, idOf(k), changes.set[k]!);
  return next;
}

/** 新 id 改回旧版本认识的旧 id(`legacyIds` 旧 id → 新 id);无需改名时返回原对象。 */
export function toLegacyIds<V>(record: Record<string, V>, legacyIds: Readonly<Record<string, string>> = {}): Record<string, V> {
  let next: Record<string, V> | null = null;
  for (const [oldId, newId] of Object.entries(legacyIds)) {
    if (!Object.hasOwn(record, newId)) continue;
    next ??= { ...record };
    setOwnValue(next, oldId, record[newId]!);
    delete next[newId];
  }
  return next ?? record;
}

/** 把权威记录(已是旧 id)写进旧键并记下镜像原文;写不进去(配额 / 超限)→ 去掉镜像记录(下次启动不推断改动)。 */
export function writeLegacyMirror(legacyKey: string, record: Record<string, unknown>): void {
  const st = getLocalStorage();
  if (st === undefined) return;
  const mirrorKey = legacyMirrorKey(legacyKey);
  try {
    const text = JSON.stringify(record);
    if (text.length > LEGACY_MIRROR_MAX_RAW_LENGTH) throw new Error('too large');
    if (st.getItem(legacyKey) !== text) st.setItem(legacyKey, text);
    if (st.getItem(mirrorKey) !== text) st.setItem(mirrorKey, text);
  } catch {
    try {
      st.removeItem(mirrorKey);
    } catch {
      // localStorage 不可用
    }
  }
}

/**
 * 首帧用的原始记录(未经 store 的值规整,与 store 初始化同一来源;入口模块 initial-theme 用):
 * 无 main → 旧 localStorage 记录;有 main → 快照,首次从旧版本升级(从未镜像过且文件不存在)→ 旧记录,降级期间旧版本改过 →
 * 快照叠上它的改动。
 */
export function initialUserSettingsRecord(
  scope: UserSettingsScope,
  legacyKey: string,
  snapshot: UserSettingsSnapshot | null = readUserSettingsSnapshot(),
): Record<string, unknown> {
  const opts = { maxEntries: 10_000, maxKeyLength: 256 };
  const s = snapshot?.[scope];
  if (!s) return readRecord<unknown>(legacyKey, opts);
  if (s.persistBlocked) return s.record;
  const lc = readLegacyChanges<unknown>(legacyKey, opts);
  if (!lc.mirrored) return s.needsImport ? lc.legacy : s.record;
  return applyLegacyChanges(s.record, lc);
}
