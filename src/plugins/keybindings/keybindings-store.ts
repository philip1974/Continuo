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
import { HOTKEY_SHAPE_RE, type CommandSpec } from '../registries/CommandRegistry';
import {
  readRecord,
  writeRecord,
  subscribeStorageKey,
  type WriteRecordResult,
} from '../storage/local-storage-record';

const STORAGE_KEY = 'continuo.keybindings.overrides';

// 可维护性 M21:localStorage 对象持久化 + 跨窗同步样板复用 local-storage-record helper。
// 边界(E22):value 守卫 + 上限。畸形/篡改 overrides 混入非字符串值会让 getEffectiveHotkey →
// compileCombo(effective).toLowerCase() 崩溃;hotkey 串本就短,限长 256;commandId(key)限长 256;
// 条目数封顶。非法项丢弃(降级到默认快捷键),不崩。
// 边界(E240,E145 写端对偶):读端 valueGuard 复用写端(setHotkey)同一 HOTKEY_SHAPE_RE 形态校验 ——
// 此前读端只验 string + 长度,但写端/注册端均拒非法形态。篡改/旧版本残留的畸形 localStorage 值(如
// mod++s 空段)会被 readStored 放行 → compileCombo 当成 mod+s 参与全局快捷键匹配 → 意外触发命令。
// 读端只接受 ''(unbind)或形态合法的 hotkey,其余丢弃(降级默认),与写端语义一致(读≡写,防旁路)。
const readStored = (): Record<string, string> =>
  readRecord<string>(STORAGE_KEY, {
    valueGuard: (v): v is string =>
      typeof v === 'string' &&
      v.length <= 256 &&
      (v === '' || HOTKEY_SHAPE_RE.test(v)),
    maxKeyLength: 256,
    maxEntries: 10_000,
  });
const writeStored = (
  overrides: Record<string, string>,
): WriteRecordResult => writeRecord(STORAGE_KEY, overrides);

function recordsShallowEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  if (a === b) return true;
  let aCount = 0;
  let bCount = 0;
  for (const key in a) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) continue;
    aCount += 1;
    if (!Object.is(a[key], b[key])) return false;
  }
  for (const key in b) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
    bCount += 1;
  }
  return aCount === bCount;
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

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  overrides: readStored(),
  // race(R6 + R113 修订,values-store 同型):单 key RMW 基于 live localStorage 重读,**缓解但不
  // 根除**多窗口 lost update。⚠️ 原注释「localStorage 同步 + 跨窗 OS 串行 → 原子」**错误**:Chromium
  // 各 renderer 缓存 localStorage、跨窗写异步广播,两窗可同时基于旧快照 merge 后互相覆盖快捷键
  // override(无跨进程原子性)。**R113 DEFER**(用户决策 2026-06-25):稳健修法=迁主进程串行 delta
  // 写,工作量大且反转既有持久化层决策,暂缓(低频、可重设)。详见 doc/race-condition-audit.md R113。
  setHotkey: (commandId, hotkey) => {
    // 边界(E145,写端校验):'' = unbind(放行);非空 hotkey 须长度 ≤ 256 且形态合法
    //(HOTKEY_SHAPE_RE,与注册侧/捕获侧同一来源)。畸形 override(含空白/空段/超长)会让
    // getEffectiveHotkey→compileCombo 产出空主键(永不触发)+ UI 显示异常 → 拒写(no-op)。
    if (hotkey !== '' && (hotkey.length > 256 || !HOTKEY_SHAPE_RE.test(hotkey))) {
      return;
    }
    const latest = readStored();
    if (latest[commandId] === hotkey) {
      if (recordsShallowEqual(get().overrides, latest)) return;
      set({ overrides: latest });
      return;
    }
    const next = { ...latest, [commandId]: hotkey };
    // 边界(E260,写读 cap 对称,values-store 同型):整份 overrides 序列化超读端 raw cap → 拒写且不提交
    // 内存态,避免下次启动 readRecord 整表返 {} = 所有快捷键 override 静默丢失。
    if (writeStored(next) === 'too-large') {
      console.warn(
        '[keybindings] setHotkey 拒写:overrides 序列化超 localStorage raw cap,保留上次有效状态',
      );
      return;
    }
    set({ overrides: next });
  },
  reset: (commandId) => {
    const latest = readStored();
    if (!(commandId in latest)) {
      set((s) => (commandId in s.overrides ? { overrides: latest } : s));
      return;
    }
    const next = { ...latest };
    delete next[commandId];
    writeStored(next);
    set({ overrides: next });
  },
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
  useKeybindingsStore.setState((s) => {
    const overrides = readStored();
    return recordsShallowEqual(s.overrides, overrides) ? s : { overrides };
  }),
);

/** 取某 command 当前生效的 hotkey(override ?? spec.hotkey),空字符串视为 unbound. */
export function getEffectiveHotkey(spec: CommandSpec): string | undefined {
  const override = useKeybindingsStore.getState().overrides[spec.id];
  if (override !== undefined) {
    return override === '' ? undefined : override;
  }
  return spec.hotkey;
}
