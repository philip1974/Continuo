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
import {
  readRecord,
  writeRecord,
  subscribeStorageKey,
} from '../storage/local-storage-record';

const STORAGE_KEY = 'continuo.keybindings.overrides';

// 可维护性 M21:localStorage 对象持久化 + 跨窗同步样板复用 local-storage-record helper。
const readStored = (): Record<string, string> =>
  readRecord<string>(STORAGE_KEY);
const writeStored = (overrides: Record<string, string>): void =>
  writeRecord(STORAGE_KEY, overrides);

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

// 跨窗口同步:overrides 用 localStorage 持久化,但 zustand 内存快照只在本窗启动时
// 读一次。多窗口下窗口 A 改/解绑快捷键 → 写 localStorage,但窗口 B 的内存仍是旧值 →
// B 的 useCommandHotkeys 仍按旧绑定派发键盘(或对已解绑的键仍触发),且设置 tab /
// CommandPalette 显示陈旧 hotkey,直到 B 重载才收敛。监听 storage 事件(仅别 document
// 改 localStorage 时 fire),同 key 重读让各窗 overrides 收敛一致(快捷键语义上 app 级
// 全局)。镜像 settings values-store 的同款修复(第二十二轮 P2-BA)。
subscribeStorageKey(STORAGE_KEY, () =>
  useKeybindingsStore.setState({ overrides: readStored() }),
);

/** 取某 command 当前生效的 hotkey(override ?? spec.hotkey),空字符串视为 unbound. */
export function getEffectiveHotkey(spec: CommandSpec): string | undefined {
  const override = useKeybindingsStore.getState().overrides[spec.id];
  if (override !== undefined) {
    return override === '' ? undefined : override;
  }
  return spec.hotkey;
}
