// 用户自定义快捷键 override(M-Settings v6.5)。
// 与 commands registry 解耦:registry 上的 spec.hotkey 仍然是 plugin 注册的
// 默认值,本 store 只存「用户改了哪些 commandId 的 hotkey」。
//
// 值域:
//   string non-empty = 自定义新组合(如 'mod+shift+x')
//   ''(空字符串)   = 显式 unbind(VSCode 同款,即「我不要这个快捷键」)
//   key 不存在        = 走 spec 默认(主键 hotkey + 附加默认键 secondaryHotkeys)
//   override(新组合或解绑)覆盖命令的全部默认键(含附加默认键);格式与多默认键之前相同,旧数据原样可读。
//
// 持久化:主进程 userData/user-keybindings.json(同 settings values store,见 storage/user-settings-record.ts);
// 旧版 localStorage 键作为给降级后旧版本看的镜像双向同步(键名 / 值格式与旧版相同)。

import { create } from 'zustand';
import {
  CMD_HOTKEY_MAX,
  CMD_ID_MAX,
  defaultHotkeysOf,
  isValidHotkeyShape,
  type CommandSpec,
} from '../registries/CommandRegistry';
import { createUserSettingsRecordOps, type UserSettingsRecordOps } from '../storage/user-settings-record';
import { notify } from '../../notifications/notify';
import { t } from '../../i18n';
import { ownValue } from '../../../electron/shared/own-value';

/** 旧版 localStorage 键(首次迁入的来源 + 给降级后旧版本看的镜像)。 */
const LEGACY_STORAGE_KEY = 'continuo.keybindings.overrides';

export interface KeybindingsState {
  /** key=commandId, value=hotkey 字符串(空 = unbind). */
  overrides: Record<string, string>;
  /** 设新 hotkey;空字符串视为 unbind. */
  setHotkey: (commandId: string, hotkey: string) => void;
  /** 删除 override → 回到 spec.hotkey. */
  reset: (commandId: string) => void;
}

// 读写 / 跨窗同步 / 一次性迁移与 settings values-store 共用 createUserSettingsRecordOps;本文件只保留读端净化与写端校验。
// 边界(E22):value 守卫 + 上限。畸形/篡改 overrides 混入非字符串值会让 getEffectiveHotkey →
// compileCombo(effective).toLowerCase() 崩溃;hotkey 限长 CMD_HOTKEY_MAX(与注册侧同一上限);commandId(key)限长 CMD_ID_MAX;
// 条目数封顶。非法项丢弃(降级到默认快捷键),不崩。
// 边界(E240,E145 写端对偶):读端 valueGuard 复用写端(setHotkey)同一 isValidHotkeyShape 形态校验 ——
// 此前读端只验 string + 长度,但写端/注册端均拒非法形态。篡改/旧版本残留的畸形值(如
// mod++s 空段)会被读端放行 → compileCombo 当成 mod+s 参与全局快捷键匹配 → 意外触发命令。
// 读端只接受 ''(unbind)或形态合法的 hotkey,其余丢弃(降级默认),与写端语义一致(读≡写,防旁路)。
// 显式标注:ops 与 store 互相引用(惰性访问器),不标注会让 TS 循环推断成 any。
const ops: UserSettingsRecordOps<string> = createUserSettingsRecordOps<string>({
  scope: 'keybindings',
  legacyKey: LEGACY_STORAGE_KEY,
  readOpts: {
    valueGuard: (v): v is string =>
      typeof v === 'string' &&
      v.length <= CMD_HOTKEY_MAX &&
      (v === '' || isValidHotkeyShape(v)),
    maxKeyLength: CMD_ID_MAX,
    maxEntries: 10_000,
  },
  getRecord: () => useKeybindingsStore.getState().overrides,
  setRecord: (overrides) => useKeybindingsStore.setState({ overrides }),
  tooLargeWarning: '[keybindings] setHotkey 拒写:快捷键记录超出上限,保留上次有效状态',
  saveFailedMessage: () => t('keybindings.persist.save_failed'),
  notSavedMessage: () => t('keybindings.persist.not_saved'),
  notify: {
    error: (message, key) => notify.error(message, { replaceKey: key }),
    warn: (message, key) => notify.warn(message, { replaceKey: key }),
  },
});

export const useKeybindingsStore = create<KeybindingsState>(() => ({
  overrides: ops.initial,
  setHotkey: (commandId, hotkey) => {
    // 边界(E145,写端校验):'' = unbind(放行);非空 hotkey 须长度 ≤ CMD_HOTKEY_MAX 且形态合法
    //(isValidHotkeyShape,与注册侧/捕获侧同一来源)。畸形 override(含空白/空段/超长)会让
    // getEffectiveHotkey→compileCombo 产出空主键(永不触发)+ UI 显示异常 → 拒写(no-op)。
    if (hotkey !== '' && (hotkey.length > CMD_HOTKEY_MAX || !isValidHotkeyShape(hotkey))) {
      return;
    }
    ops.setEntry(commandId, hotkey);
  },
  reset: (commandId) => ops.removeEntry(commandId),
}));

/**
 * 「有效快捷键」解析的单一来源(纯函数):有 override 用 override,**空串 = 用户显式解绑**(→ undefined);
 * 无 override 用命令默认 hotkey。命令面板显示、全局 hotkey 触发、快捷键设置页、冲突检测都必须走这里 ——
 * 此前 5 处各手写一份,漏改任何一处就是「面板显示的键 ≠ 实际触发的键」。
 */
export function resolveEffectiveHotkey(
  spec: Pick<CommandSpec, 'id' | 'hotkey' | 'secondaryHotkeys'>,
  overrides: Readonly<Record<string, string>>,
): string | undefined {
  // 只认自有属性:命令 id 为 toString / constructor 等时不得命中原型链返回函数(compileCombo 会抛 → 整窗白屏)。
  const override = ownValue(overrides, spec.id);
  if (override !== undefined) return override === '' ? undefined : override;
  return spec.hotkey ? spec.hotkey : spec.secondaryHotkeys?.[0];
}

const NO_HOTKEYS: readonly string[] = [];

/**
 * 全部生效键(主键在前):有 override → 只有它(空串 = 解绑 → 无);无 → 命令的全部默认键(主键 + 附加默认键)。
 * 分发 / 冲突判定用它;显示只取第一条(= resolveEffectiveHotkey)。
 */
export function resolveEffectiveHotkeys(
  spec: Pick<CommandSpec, 'id' | 'hotkey' | 'secondaryHotkeys'>,
  overrides: Readonly<Record<string, string>>,
): readonly string[] {
  const override = ownValue(overrides, spec.id);
  if (override !== undefined) return override === '' ? NO_HOTKEYS : [override];
  return defaultHotkeysOf(spec);
}

/** 取某 command 当前生效的 hotkey(读 store 的当前 overrides)。 */
export function getEffectiveHotkey(spec: CommandSpec): string | undefined {
  return resolveEffectiveHotkey(spec, useKeybindingsStore.getState().overrides);
}
