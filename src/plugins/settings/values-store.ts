// 设置项值的全局 store(M-Settings v6)。
// key=SettingItemSpec.id,value=Spec.default 类型;只存 partial overrides,
// 默认值由 spec 提供(reset 即删 key)。
//
// 持久化:主进程 userData/user-settings.json(每次修改立即原子写盘,各窗口经 main 广播同步),见
// storage/user-settings-record.ts;旧版 localStorage 键作为给降级后旧版本看的镜像双向同步。

import { create } from 'zustand';
import {
  coerceSettingValue,
  SI_TEXT_VALUE_MAX,
  type SettingItemValue,
} from '../registries/SettingItemRegistry';
import { createUserSettingsRecordOps, type UserSettingsRecordOps } from '../storage/user-settings-record';
import { notify } from '../../notifications/notify';
import { t } from '../../i18n';
import { coApp } from '../co-app';
import { ownValue } from '../../../electron/shared/own-value';
import { SETTINGS_VALUES_STORAGE_KEY } from './storage-key';
import { LEGACY_SETTING_IDS } from './core-setting-specs';


// 边界(E142/E241):单个 text/string 设置值长度上限。setValue 写入前截断 —— 否则用户在 text setting
// 粘贴超大文本会撑大整份设置记录(超 main 文件上限即拒写)。64KiB 远超任何真实设置文本,只挡滥用/误操作。常量收口到
// SettingItemRegistry(coerceSettingValue 家),读端(useSettingValue 经 coerce)也用同值。
const MAX_SETTING_TEXT_LEN = SI_TEXT_VALUE_MAX;

export interface SettingsValueState {
  /** partial overrides(未写过的 key 走 spec.default). */
  values: Record<string, SettingItemValue>;
  setValue: (id: string, value: SettingItemValue) => void;
  /** 删除某 id 的 override(回到 spec.default). */
  reset: (id: string) => void;
}

// 本窗口用户主动「恢复默认」的通知(不随 storage 事件 / 跨窗同步触发)。需要把重置传给外部权威源的设置项
// (如语言 → main settings.json)订阅它,而不是从「存储值消失」推断 —— 后者会把跨窗 lost update / 清站点数据
// 误当成用户重置。
const localResetListeners = new Set<(id: string) => void>();
export function onLocalSettingReset(cb: (id: string) => void): () => void {
  localResetListeners.add(cb);
  return () => {
    localResetListeners.delete(cb);
  };
}

/**
 * 设置 id 改名迁移(LEGACY_SETTING_IDS,如 terminal.fontSize → terminal.integrated.fontSize):旧 id 的值改记到新 id
 *(新 id 已有值则以新 id 为准),旧 id 删除。无旧 id 时返回原对象。
 */
const LEGACY_SETTING_ID_PAIRS: readonly (readonly [string, string])[] = Object.entries(LEGACY_SETTING_IDS);

export function migrateLegacySettingIds<V>(
  record: Record<string, V>,
  legacy: readonly (readonly [string, string])[] = LEGACY_SETTING_ID_PAIRS,
): Record<string, V> {
  let next: Record<string, V> | null = null;
  for (const [oldId, newId] of legacy) {
    if (!Object.hasOwn(record, oldId)) continue;
    next ??= { ...record };
    if (!Object.hasOwn(next, newId)) next[newId] = record[oldId]!;
    delete next[oldId];
  }
  return next ?? record;
}

// 读写 / 跨窗同步 / 一次性迁移与 keybindings-store 共用 createUserSettingsRecordOps;本文件只保留读端守卫、写端净化与 reset 通知。
// 跨窗同步对 settings 尤其必要:否则窗口 B 的陈旧 values 会让 LanguageFromSettings 的 values→store
// 协调 effect 把刚广播来的 locale 又改回去(跨窗 locale 互斗)。
// 边界(E22):value 守卫 + 上限。settings 值只接受原语(string/number/boolean),畸形/篡改的
// 记录混入对象/数组会被读端直接返出污染消费者;number 越界由读端 coerceSettingValue
// 的 clampSettingNumber(E6)钳制。key 限长 256、条目数封顶,非法项丢弃(回退 spec.default)。
// 显式标注:ops 与 store 互相引用(惰性访问器),不标注会让 TS 循环推断成 any。
const ops: UserSettingsRecordOps<SettingItemValue> = createUserSettingsRecordOps<SettingItemValue>({
  scope: 'settings',
  legacyKey: SETTINGS_VALUES_STORAGE_KEY,
  readOpts: {
    // 边界(E122,E22 延伸):number 须有限(Number.isFinite),拒 Infinity/NaN。
    valueGuard: (v): v is SettingItemValue =>
      typeof v === 'string' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      typeof v === 'boolean',
    maxKeyLength: 256,
    maxEntries: 10_000,
  },
  getRecord: () => useSettingsValuesStore.getState().values,
  setRecord: (values) => useSettingsValuesStore.setState({ values }),
  tooLargeWarning: '[settings] setValue 拒写:设置记录超出上限,保留上次有效状态',
  saveFailedMessage: () => t('settings.persist.save_failed'),
  notSavedMessage: () => t('settings.persist.not_saved'),
  notify: {
    error: (message, key) => notify.error(message, { replaceKey: key }),
    warn: (message, key) => notify.warn(message, { replaceKey: key }),
  },
  migrate: (record) => migrateLegacySettingIds(record),
  // 镜像回旧 localStorage 键时写旧 id(0.2.15 只认 terminal.fontSize / terminal.cursorStyle)。
  legacyIds: LEGACY_SETTING_IDS,
});

export const useSettingsValuesStore = create<SettingsValueState>(() => ({
  values: ops.initial,
  setValue: (id, value) => {
    // 边界(E142,E122/E139 读路径净化的写侧对偶):写入前按 live spec 净化 —— number clamp /
    // select enum(coerceSettingValue),text/string 截断到 MAX_SETTING_TEXT_LEN。防超大 text 撑爆
    // 整份设置记录(超上限被 main 拒写)+ 持久化非法值。spec 未注册原样(graceful)。
    const spec = coApp.settingItems.get(id);
    let v = spec ? coerceSettingValue(spec, value) : value;
    if (typeof v === 'string' && v.length > MAX_SETTING_TEXT_LEN) {
      v = v.slice(0, MAX_SETTING_TEXT_LEN);
    }
    ops.setEntry(id, v);
  },
  reset: (id) => {
    ops.removeEntry(id);
    // 用户本意是重置(即便 key 已被别窗删掉):通知订阅方同步外部权威源。
    for (const cb of [...localResetListeners]) cb(id);
  },
}));

/** 取某 setting id 的已存储值(无 → undefined);只认自有属性,见 ownValue。 */
export function getStoredSettingValue(id: string): SettingItemValue | undefined {
  return ownValue(useSettingsValuesStore.getState().values, id);
}

/**
 * React hook:订阅某 setting id 的值,变化时组件重渲。未存值时用已注册 spec 的 default(与设置页显示的默认同源);
 * `fallback` 只在 spec 未注册(测试 / 早期)时兜底。
 */
export function useSettingValue<T extends SettingItemValue>(
  id: string,
  fallback: T,
): T {
  return useSettingsValuesStore((s) => {
    const stored = ownValue(s.values, id);
    // 边界(E122 number clamp + E139 select enum,E6 读路径对齐):按注册 spec 规整值(coerceSettingValue)
    // —— 篡改/旧 localStorage 的越界 number 或非法 select 字符串(如
    // terminal.integrated.cursorStyle)绕过净化直接喂给 xterm/CSS/timer 等消费者。spec 未注册(测试/早期)原样返回。
    const spec = coApp.settingItems.get(id);
    if (spec) return coerceSettingValue(spec, stored ?? spec.default) as T;
    return (stored ?? fallback) as T;
  });
}
