// 用户设置值与快捷键覆盖的权威存储(此前在 renderer localStorage:Chromium 延迟数秒才把 localStorage 刷到磁盘,改完后
// 主进程崩溃 / 强杀 / 断电会丢掉刚改的设置)。
// 对齐 VSCode:`User/settings.json` / `User/keybindings.json`,每次修改立即写盘(configurationEditing / keybindingEditing 经 Queue
// 串行编辑并保存),写盘 fsync(diskFileSystemProvider 关闭写句柄前 fdatasync);这里再用原子写(临时文件 + fsync + rename)。
// 文件名不用 settings.json:那是 main 自己的 {version, locale} 严格 schema(加字段会让旧版本把它当损坏隔离)。
//
// 落盘时机:UPDATE / IMPORT 在 main 串行队列里读-改-写,rename 完成后才更新内存、广播并回复 renderer —— IPC 返回后进程被
// kill -9 / 断电也不丢;丢失窗口只剩「renderer 发起 → main rename 完成」这几毫秒。
//
// 数据安全(同 trusted-domains.service):
// - 缺文件 = 空记录,needsImport(首次启动新版本:renderer 把旧 localStorage 迁入,见 importUserSettings)。
// - 读得出来但内容不对(JSON 坏 / 非对象 / 条目非法 / 超大)= 损坏:原文件隔离为 `.corrupt` 留证,合法条目抢救出来立即写回,
//   之后照常写盘(不因一次损坏让以后的修改永远存不下来;文件存在 → 也不会再从旧 localStorage 迁入陈旧值)。
// - 读不出来(权限 / IO 错误,内容未知)→ 本次运行按空记录,修改只留在内存(各窗口照常同步),**不写盘**(不拿「读不出来」
//   当「空」覆盖原文件);renderer 据 persistBlocked 提示「本次修改不会保存」。
// BDD: src/__tests__/user-settings-main-store/
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { atomicWriteJsonCapped } from '../lib/atomic-write';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { quarantineCorruptFile } from '../lib/corrupt-snapshot';
import { createSerialQueue } from '../../shared/run-serial-per-key';
import { ownValue, setOwnValue } from '../../shared/own-value';
import { ERROR_CODES } from '../../shared/error-codes';
import { codedError } from '../../shared/error-message';
import {
  USER_SETTINGS_ENTRIES_MAX,
  USER_SETTINGS_FILE_MAX_BYTES,
  USER_SETTINGS_KEY_MAX,
  USER_SETTINGS_SCOPES,
  isUserSettingsValue,
  type UserSettingsRecord,
  type UserSettingsScope,
  type UserSettingsScopeSnapshot,
  type UserSettingsScopeState,
  type UserSettingsSnapshot,
} from '../../shared/user-settings';

export const USER_SETTINGS_FILE_NAMES: Readonly<Record<UserSettingsScope, string>> = {
  settings: 'user-settings.json',
  keybindings: 'user-keybindings.json',
};

interface ScopeState {
  record: UserSettingsRecord;
  version: number;
  loaded: boolean;
  /** 文件原本不存在且本次运行还没写过。 */
  missing: boolean;
  /** 读盘 IO 失败:本次运行不写盘。 */
  writeBlocked: boolean;
}

const freshState = (): ScopeState => ({ record: {}, version: 0, loaded: false, missing: false, writeBlocked: false });

const states: Record<UserSettingsScope, ScopeState> = { settings: freshState(), keybindings: freshState() };
const queues = { settings: createSerialQueue(), keybindings: createSerialQueue() };
const listeners = new Set<(scope: UserSettingsScope, state: UserSettingsScopeState) => void>();
// 版本跨 scope 共用一个单调计数(只需每个 scope 内单调)。
let versionCounter = 0;

const fileOf = (scope: UserSettingsScope): string =>
  path.join(app.getPath('userData'), USER_SETTINGS_FILE_NAMES[scope]);

/** 合法条目(有界迭代);`clean` = 原对象每一项都合法且未超条目上限。 */
function sanitize(input: Record<string, unknown>): { record: UserSettingsRecord; clean: boolean } {
  const record: UserSettingsRecord = {};
  let clean = true;
  let n = 0;
  for (const k in input) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    const v = input[k];
    if (k.length > USER_SETTINGS_KEY_MAX || !isUserSettingsValue(v)) {
      clean = false;
      continue;
    }
    if (n >= USER_SETTINGS_ENTRIES_MAX) {
      clean = false;
      break;
    }
    setOwnValue(record, k, v);
    n += 1;
  }
  return { record, clean };
}

function parseRecord(text: string): { record: UserSettingsRecord; clean: boolean } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { record: {}, clean: false };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { record: {}, clean: false };
  return sanitize(json as Record<string, unknown>);
}

async function loadScope(scope: UserSettingsScope): Promise<void> {
  const st = states[scope];
  if (st.loaded) return;
  const file = fileOf(scope);
  let text: string | null;
  try {
    const r = await readFileCappedFd(file, USER_SETTINGS_FILE_MAX_BYTES);
    text = r.tooLarge ? null : (r.text as string);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      st.missing = true;
    } else {
      st.writeBlocked = true;
      console.warn(`[user-settings] ${scope}: read failed; changes will not be saved this session`, err);
    }
    st.record = {};
    st.version = ++versionCounter;
    st.loaded = true;
    return;
  }
  const parsed = text === null ? { record: {}, clean: false } : parseRecord(text);
  st.record = parsed.record;
  if (!parsed.clean) {
    // 损坏(含超大):隔离留证,抢救合法条目并写回(空也写:文件存在即「已迁移」,不再从旧 localStorage 迁入陈旧值)。
    console.warn(`[user-settings] ${scope}: file is corrupt; moved aside to .corrupt`);
    await quarantineCorruptFile(file);
    try {
      await atomicWriteJsonCapped(file, st.record, USER_SETTINGS_FILE_MAX_BYTES);
    } catch (err) {
      console.warn(`[user-settings] ${scope}: failed to save salvaged entries`, err);
    }
  }
  st.version = ++versionCounter;
  st.loaded = true;
}

/** 启动时(建任何窗口之前)读入两类记录;永不抛(失败按上面的降级处理)。renderer 首帧经同步快照拿到它们。 */
export async function loadUserSettings(): Promise<void> {
  await Promise.all(USER_SETTINGS_SCOPES.map((scope) => queues[scope].run(() => loadScope(scope))));
}

const publicState = (st: ScopeState): UserSettingsScopeState => ({ version: st.version, record: st.record });

/** 两类记录的当前快照(同步;loadUserSettings 之前调用得到空记录)。 */
export function getUserSettingsSnapshot(): UserSettingsSnapshot {
  const one = (scope: UserSettingsScope): UserSettingsScopeSnapshot => {
    const st = states[scope];
    return { ...publicState(st), needsImport: st.missing, persistBlocked: st.writeBlocked };
  };
  return { settings: one('settings'), keybindings: one('keybindings') };
}

/** 在队列内:写盘(读盘失败时跳过)成功后才提交内存、递增版本并通知订阅方(各窗口)。 */
async function commit(scope: UserSettingsScope, next: UserSettingsRecord): Promise<void> {
  const st = states[scope];
  if (!st.writeBlocked) await atomicWriteJsonCapped(fileOf(scope), next, USER_SETTINGS_FILE_MAX_BYTES);
  st.record = next;
  st.missing = false;
  st.version = ++versionCounter;
  const state = publicState(st);
  for (const l of [...listeners]) {
    try {
      l(scope, state);
    } catch (err) {
      console.error('[user-settings] listener failed', err);
    }
  }
}

function countEntries(r: UserSettingsRecord): number {
  let n = 0;
  for (const k in r) if (Object.prototype.hasOwnProperty.call(r, k)) n += 1;
  return n;
}

/**
 * 增量修改一类记录:先删 remove 里的 key,再设 set 里的值(读-改-写都在 main 串行队列内,多窗口并发改不同 key 不互相覆盖)。
 * 无变化不写盘。超条目上限 / 超文件字节上限 → 抛 PAYLOAD_TOO_LARGE,记录不变;写盘失败照样抛,记录不变。
 */
export function updateUserSettings(
  scope: UserSettingsScope,
  set: UserSettingsRecord,
  remove: readonly string[],
): Promise<UserSettingsScopeState> {
  return queues[scope].run(async () => {
    await loadScope(scope);
    const st = states[scope];
    let next: UserSettingsRecord | null = null;
    for (const k of remove) {
      if (!Object.hasOwn(st.record, k)) continue;
      next ??= { ...st.record };
      delete next[k];
    }
    for (const k in set) {
      if (!Object.prototype.hasOwnProperty.call(set, k)) continue;
      const v = set[k]!;
      if (Object.is(ownValue(next ?? st.record, k), v)) continue;
      next ??= { ...st.record };
      setOwnValue(next, k, v);
    }
    if (next === null) return publicState(st);
    if (countEntries(next) > USER_SETTINGS_ENTRIES_MAX) {
      throw codedError(ERROR_CODES.PAYLOAD_TOO_LARGE, `${scope}: more than ${USER_SETTINGS_ENTRIES_MAX} entries`);
    }
    await commit(scope, next);
    return publicState(st);
  });
}

/**
 * 一次性迁入旧版 renderer localStorage 里的记录:仅当文件原本不存在且本次运行还没写过(needsImport)才生效,否则原样返回当前
 * 状态(多个窗口同时迁入 / 迁入前已有修改 → 只认文件)。
 */
export function importUserSettings(scope: UserSettingsScope, record: UserSettingsRecord): Promise<UserSettingsScopeState> {
  return queues[scope].run(async () => {
    await loadScope(scope);
    const st = states[scope];
    if (!st.missing) return publicState(st);
    const { record: clean } = sanitize(record);
    if (countEntries(clean) === 0) return publicState(st);
    await commit(scope, clean);
    return publicState(st);
  });
}

/** 语言设置项的 id(= renderer GENERAL_LANGUAGE.id)。 */
export const LANGUAGE_SETTING_ID = 'general.language';

async function mtimeMs(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 启动时(建窗前)对齐语言:界面语言的权威在 main 的 settings.json(locale),设置项 general.language 在 user-settings.json,
 * 平时两边一起改。只改了一边(降级期间旧版本改了语言而它的 localStorage 没来得及落盘 / 两次写之间崩溃)时较新者胜:
 * settings.json 较新 → 把 locale 写进 general.language(等于系统默认则删掉 = 默认);user-settings.json 较新 → 不动
 *(renderer LanguageFromSettings 照常把 general.language 推给 main)。文件不存在(首次迁入还没做)/ 读盘失败 → 不动。永不抛。
 */
export async function adoptNewerLocale(locale: string, systemLocale: string, localeFile: string): Promise<void> {
  try {
    await queues.settings.run(async () => {
      await loadScope('settings');
      const st = states.settings;
      if (st.missing || st.writeBlocked) return;
      const stored = ownValue(st.record, LANGUAGE_SETTING_ID);
      if ((typeof stored === 'string' ? stored : systemLocale) === locale) return;
      const [localeAt, settingsAt] = await Promise.all([mtimeMs(localeFile), mtimeMs(fileOf('settings'))]);
      if (localeAt === null || settingsAt === null || localeAt <= settingsAt) return;
      const next = { ...st.record };
      if (locale === systemLocale) delete next[LANGUAGE_SETTING_ID];
      else setOwnValue(next, LANGUAGE_SETTING_ID, locale);
      await commit('settings', next);
    });
  } catch (err) {
    console.warn('[user-settings] language reconcile skipped', err);
  }
}

export function onUserSettingsChanged(cb: (scope: UserSettingsScope, state: UserSettingsScopeState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test helper。 */
export function _resetUserSettingsForTest(): void {
  states.settings = freshState();
  states.keybindings = freshState();
  queues.settings.reset();
  queues.keybindings.reset();
  listeners.clear();
}
