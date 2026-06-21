// 设置项值的全局 store(M-Settings v6)。
// key=SettingItemSpec.id,value=Spec.default 类型;只存 partial overrides,
// 默认值由 spec 提供(reset 即删 key)。
//
// 持久化:localStorage 简单 JSON,与 ThemeProvider 同样的轻量策略;
// 不进 explorer.json 避免持久化层耦合扩张。

import { create } from 'zustand';
import type {
  SettingItemSpec,
  SettingItemValue,
} from '../registries/SettingItemRegistry';
import {
  readRecord,
  writeRecord,
  subscribeStorageKey,
} from '../storage/local-storage-record';

const STORAGE_KEY = 'continuo.settings.values';

// 可维护性 M21:localStorage 对象持久化 + 跨窗同步样板复用 local-storage-record helper。
const readStored = (): Record<string, SettingItemValue> =>
  readRecord<SettingItemValue>(STORAGE_KEY);
const writeStored = (values: Record<string, SettingItemValue>): void =>
  writeRecord(STORAGE_KEY, values);

export interface SettingsValueState {
  /** partial overrides(未写过的 key 走 spec.default). */
  values: Record<string, SettingItemValue>;
  setValue: (id: string, value: SettingItemValue) => void;
  /** 删除某 id 的 override(回到 spec.default). */
  reset: (id: string) => void;
  /** 清空所有 overrides. */
  resetAll: () => void;
}

export const useSettingsValuesStore = create<SettingsValueState>((set) => ({
  values: readStored(),
  setValue: (id, value) =>
    set((s) => {
      const next = { ...s.values, [id]: value };
      writeStored(next);
      return { values: next };
    }),
  reset: (id) =>
    set((s) => {
      if (!(id in s.values)) return s;
      const next = { ...s.values };
      delete next[id];
      writeStored(next);
      return { values: next };
    }),
  resetAll: () => {
    writeStored({});
    set(() => ({ values: {} }));
  },
}));

// 跨窗口同步:localStorage 在同源多窗口共享,但 zustand 内存快照只在本窗启动时
// 读一次、之后不随别窗的写而更新。多窗口下窗口 A 改设置 → 写 localStorage + 经
// settings 广播更新 useSettingsStore,但窗口 B 的 values-store 内存仍是旧值 →
// LanguageFromSettings 的 values→store 协调 effect 会拿 B 的陈旧 value 把刚广播来的
// locale 又改回去(跨窗 locale 互斗)。监听 storage 事件(只在别的 document 改了
// localStorage 时 fire),同一 key 就重读,让所有窗口的 values 收敛一致(设置语义上
// 都是 app 级全局,跨窗一致也更符合预期)。
subscribeStorageKey(STORAGE_KEY, () =>
  useSettingsValuesStore.setState({ values: readStored() }),
);

/** 取某 spec 当前值(override ?? default). 非 React 上下文用. */
export function getSettingValue<T extends SettingItemValue>(
  spec: SettingItemSpec,
): T {
  const stored = useSettingsValuesStore.getState().values[spec.id];
  return (stored ?? spec.default) as T;
}

/** React hook:订阅某 setting id 的值,变化时组件重渲. fallback = 该 id 的 spec.default. */
export function useSettingValue<T extends SettingItemValue>(
  id: string,
  fallback: T,
): T {
  return useSettingsValuesStore(
    (s) => (s.values[id] ?? fallback) as T,
  );
}
