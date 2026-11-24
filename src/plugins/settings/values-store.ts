// 设置项值的全局 store(M-Settings v6)。
// key=SettingItemSpec.id,value=Spec.default 类型;只存 partial overrides,
// 默认值由 spec 提供(reset 即删 key)。
//
// 持久化:localStorage 简单 JSON,与 ThemeProvider 同样的轻量策略;
// 不进 explorer.json 避免持久化层耦合扩张。

import { create } from 'zustand';
import {
  coerceSettingValue,
  SI_TEXT_VALUE_MAX,
  type SettingItemValue,
} from '../registries/SettingItemRegistry';
import { createRecordStoreOps, type RecordStoreOps } from '../storage/local-storage-record';
import { coApp } from '../co-app';
import { ownValue } from '../../../electron/shared/own-value';
import { SETTINGS_VALUES_STORAGE_KEY } from './storage-key';


// 边界(E142/E241):单个 text/string 设置值长度上限。setValue 写入前截断 —— 否则用户在 text setting
// 粘贴超大文本会进 zustand+localStorage,整份 settings 记录超 readRecord 1MiB raw cap 后下次启动
// 被当空表丢弃(所有设置丢失)。64KiB 远超任何真实设置文本,只挡滥用/误操作。常量收口到
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

// localStorage 读-改-写 / 重置 / 跨窗同步(R6/R113 race 缓解、E260 写读 cap 对称、P2-BA 跨窗收敛)
// 与 keybindings-store 共用 createRecordStoreOps;本文件只保留 key、读端守卫、写端净化与 reset 通知。
// 跨窗同步对 settings 尤其必要:否则窗口 B 的陈旧 values 会让 LanguageFromSettings 的 values→store
// 协调 effect 把刚广播来的 locale 又改回去(跨窗 locale 互斗)。
// 边界(E22):value 守卫 + 上限。settings 值只接受原语(string/number/boolean),畸形/篡改的
// localStorage 混入对象/数组会被读端直接返出污染消费者;number 越界由读端 coerceSettingValue
// 的 clampSettingNumber(E6)钳制。key 限长 256、条目数封顶,非法项丢弃(回退 spec.default)。
// 显式标注:ops 与 store 互相引用(惰性访问器),不标注会让 TS 循环推断成 any。
const ops: RecordStoreOps<SettingItemValue> = createRecordStoreOps<SettingItemValue>({
  key: SETTINGS_VALUES_STORAGE_KEY,
  readOpts: {
    // 边界(E122,E22 延伸):number 须有限(Number.isFinite),拒 Infinity/NaN —— 经 setValue 写入
    // 的非有限值虽在 JSON 落盘时被 stringify 成 null,但其它入口/未来格式不应放行非有限 number。
    valueGuard: (v): v is SettingItemValue =>
      typeof v === 'string' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      typeof v === 'boolean',
    maxKeyLength: 256,
    maxEntries: 10_000,
  },
  getRecord: () => useSettingsValuesStore.getState().values,
  setRecord: (values) => useSettingsValuesStore.setState({ values }),
  tooLargeWarning:
    '[settings] setValue 拒写:overrides 序列化超 localStorage raw cap,保留上次有效状态',
});

export const useSettingsValuesStore = create<SettingsValueState>(() => ({
  values: ops.read(),
  setValue: (id, value) => {
    // 边界(E142,E122/E139 读路径净化的写侧对偶):写入前按 live spec 净化 —— number clamp /
    // select enum(coerceSettingValue),text/string 截断到 MAX_SETTING_TEXT_LEN。防超大 text 撑爆
    // settings localStorage 整份记录(1MiB raw cap 超限丢全表)+ 持久化非法值。spec 未注册原样(graceful)。
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
    // terminal.cursorStyle)绕过净化直接喂给 xterm/CSS/timer 等消费者。spec 未注册(测试/早期)原样返回。
    const spec = coApp.settingItems.get(id);
    if (spec) return coerceSettingValue(spec, stored ?? spec.default) as T;
    return (stored ?? fallback) as T;
  });
}
