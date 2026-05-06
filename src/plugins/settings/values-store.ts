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

const STORAGE_KEY = 'continuo.settings.values';

function readStored(): Record<string, SettingItemValue> {
  if (typeof globalThis.localStorage === 'undefined') return {};
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, SettingItemValue>)
      : {};
  } catch {
    return {};
  }
}

function writeStored(values: Record<string, SettingItemValue>): void {
  if (typeof globalThis.localStorage === 'undefined') return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // quota / disabled — 静默
  }
}

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

/** 取某 spec 当前值(override ?? default). 非 React 上下文用. */
export function getSettingValue<T extends SettingItemValue>(
  spec: SettingItemSpec,
): T {
  const stored = useSettingsValuesStore.getState().values[spec.id];
  return (stored ?? spec.default) as T;
}
