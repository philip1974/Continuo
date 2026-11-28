// 用户设置值 / 快捷键覆盖的主进程权威存储:通道、快照形态与限幅(main / preload / renderer 共用)。
// 对齐 VSCode:设置与快捷键存在 userData 下的文件(VSCode `User/settings.json` / `User/keybindings.json`),每次修改立即写盘;
// 各窗口经 main 同步(VSCode 是各窗口监听文件变化,这里由 main 串行写并广播)。
// BDD: src/__tests__/user-settings-main-store/

/** 两类记录:设置值(id → 原语)与快捷键覆盖(commandId → hotkey,'' = 解绑)。 */
export const USER_SETTINGS_SCOPES = ['settings', 'keybindings'] as const;
export type UserSettingsScope = (typeof USER_SETTINGS_SCOPES)[number];

export type UserSettingsValue = string | number | boolean;
export type UserSettingsRecord = Record<string, UserSettingsValue>;

export const USER_SETTINGS_CHANNELS = {
  /** 同步(sendSync):两类记录的当前快照,renderer 首帧前读(主题 / 字号等不闪)。 */
  SNAPSHOT: 'user-settings:snapshot',
  /** invoke:对一类记录做增量修改(设若干 key、删若干 key),写盘后返回新状态。 */
  UPDATE: 'user-settings:update',
  /** invoke:一次性迁入旧版 renderer localStorage 里的记录(仅文件原本不存在且本次运行未写过时生效)。 */
  IMPORT: 'user-settings:import',
  /** main → 所有窗口:某类记录变了(payload: UserSettingsChanged)。 */
  CHANGED: 'user-settings:changed',
} as const;

/** 单 key 长度上限(设置 id / 命令 id;renderer 端另有更严的形态校验)。 */
export const USER_SETTINGS_KEY_MAX = 256;
/** 单个字符串值长度上限(renderer 写端截断 text 设置到同值,见 SettingItemRegistry.SI_TEXT_VALUE_MAX)。 */
export const USER_SETTINGS_TEXT_MAX = 64 * 1024;
/** 每类记录的条目数上限。 */
export const USER_SETTINGS_ENTRIES_MAX = 10_000;
/** 单次 UPDATE 的 set / remove 条目上限(迁移旧 id 时一次最多改这么多)。 */
export const USER_SETTINGS_UPDATE_MAX = 1_000;
/** 文件(按落盘序列化的 UTF-8 字节)上限:读写同一个值,写不出读不回来的文件。 */
export const USER_SETTINGS_FILE_MAX_BYTES = 2 * 1024 * 1024;

export interface UserSettingsScopeState {
  /** main 进程内单调递增的版本;renderer 只接受比已知更新的状态(乱序到达的旧广播被忽略)。 */
  readonly version: number;
  readonly record: UserSettingsRecord;
}

export interface UserSettingsScopeSnapshot extends UserSettingsScopeState {
  /** 文件原本不存在、本次运行也还没写过:renderer 应把旧版 localStorage 里的记录经 IMPORT 迁入。 */
  readonly needsImport: boolean;
  /** 读盘失败(IO,非损坏):本次运行的修改不会写盘(不拿「读不出来」当「空」覆盖原文件)。 */
  readonly persistBlocked: boolean;
}

export type UserSettingsSnapshot = Readonly<Record<UserSettingsScope, UserSettingsScopeSnapshot>>;

export interface UserSettingsChanged extends UserSettingsScopeState {
  readonly scope: UserSettingsScope;
}

/** 值的基本形态(main 端守卫;renderer 端再按设置 spec / hotkey 形态做更严的规整)。 */
export function isUserSettingsValue(v: unknown): v is UserSettingsValue {
  return (
    (typeof v === 'string' && v.length <= USER_SETTINGS_TEXT_MAX) ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    typeof v === 'boolean'
  );
}

export function isUserSettingsScope(v: unknown): v is UserSettingsScope {
  return v === 'settings' || v === 'keybindings';
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 记录形态守卫(preload / renderer 收到快照与广播时用;条目逐个校验)。 */
export function isUserSettingsRecord(v: unknown): v is UserSettingsRecord {
  if (!isPlainRecord(v)) return false;
  let n = 0;
  for (const k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    if (++n > USER_SETTINGS_ENTRIES_MAX || k.length > USER_SETTINGS_KEY_MAX || !isUserSettingsValue(v[k])) return false;
  }
  return true;
}

export function isUserSettingsScopeState(v: unknown): v is UserSettingsScopeState {
  return (
    isPlainRecord(v) &&
    typeof v['version'] === 'number' &&
    Number.isSafeInteger(v['version']) &&
    isUserSettingsRecord(v['record'])
  );
}

export function isUserSettingsChanged(v: unknown): v is UserSettingsChanged {
  return isUserSettingsScopeState(v) && isUserSettingsScope((v as unknown as Record<string, unknown>)['scope']);
}

export function isUserSettingsSnapshot(v: unknown): v is UserSettingsSnapshot {
  if (!isPlainRecord(v)) return false;
  return USER_SETTINGS_SCOPES.every((scope) => {
    const s = v[scope];
    return (
      isUserSettingsScopeState(s) &&
      typeof (s as unknown as Record<string, unknown>)['needsImport'] === 'boolean' &&
      typeof (s as unknown as Record<string, unknown>)['persistBlocked'] === 'boolean'
    );
  });
}
