// 用户自定义快捷键 override(M-Settings v6.5)。
// 与 commands registry 解耦:registry 上的 spec.hotkey 仍然是 plugin 注册的
// 默认值,本 store 只存「用户改了哪些 commandId 的 hotkey」。
//
// 值域:
//   string non-empty = 自定义新组合(如 'mod+shift+x')
//   ''(空字符串)   = 显式 unbind(VSCode 同款,即「我不要这个快捷键」)
//   key 不存在        = 走 spec 默认
//
// 持久化:localStorage(同 settings values store 的轻量策略)。

import { create } from 'zustand';
import type { CommandSpec } from '../registries/CommandRegistry';

const STORAGE_KEY = 'continuo.keybindings.overrides';

function readStored(): Record<string, string> {
  if (typeof globalThis.localStorage === 'undefined') return {};
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeStored(overrides: Record<string, string>): void {
  if (typeof globalThis.localStorage === 'undefined') return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* quota / disabled — 静默 */
  }
}

export interface KeybindingsState {
  /** key=commandId, value=hotkey 字符串(空 = unbind). */
  overrides: Record<string, string>;
  /** 设新 hotkey;空字符串视为 unbind. */
  setHotkey: (commandId: string, hotkey: string) => void;
  /** 删除 override → 回到 spec.hotkey. */
  reset: (commandId: string) => void;
  /** 清空所有 override. */
  resetAll: () => void;
}

export const useKeybindingsStore = create<KeybindingsState>((set) => ({
  overrides: readStored(),
  setHotkey: (commandId, hotkey) =>
    set((s) => {
      const next = { ...s.overrides, [commandId]: hotkey };
      writeStored(next);
      return { overrides: next };
    }),
  reset: (commandId) =>
    set((s) => {
      if (!(commandId in s.overrides)) return s;
      const next = { ...s.overrides };
      delete next[commandId];
      writeStored(next);
      return { overrides: next };
    }),
  resetAll: () => {
    writeStored({});
    set(() => ({ overrides: {} }));
  },
}));

/** 取某 command 当前生效的 hotkey(override ?? spec.hotkey),空字符串视为 unbound. */
export function getEffectiveHotkey(spec: CommandSpec): string | undefined {
  const override = useKeybindingsStore.getState().overrides[spec.id];
  if (override !== undefined) {
    return override === '' ? undefined : override;
  }
  return spec.hotkey;
}
