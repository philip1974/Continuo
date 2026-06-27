import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../lib/atomic-write';
import { readFileCappedFd } from '../lib/read-fh-capped';
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  mapSystemLocale,
  type Locale,
  type Settings,
} from '../../shared/i18n-types';

// 边界(E69):settings.json 读前大小上限。语义只有 {version, locale},正常仅数十字节,
// 64KiB 已是天文余量;超大必为损坏/恶意,当 corrupt 隔离(见 loadSettings)。
const MAX_SETTINGS_FILE_BYTES = 64 * 1024;

// settings.service 内部 mutex，独立于 explorer 文件锁。
let settingsChain: Promise<unknown> = Promise.resolve();
async function withSettingsMutex<T>(fn: () => Promise<T>): Promise<T> {
  const result = settingsChain.then(fn, fn);
  settingsChain = result.catch(() => undefined);
  return result;
}

let cached: Settings | null = null;
let setLocaleGen = 0;
// race(R36):已成功提交(写盘成功)的最大 gen。setLocaleGen 是「已发起 gen」(在 await 前递增,
// 仅用于排序),用它判广播会把「请求已发起」和「请求已成功提交」混淆 —— 后发起者递增 gen 后即便
// 写盘失败,也会让先发起且已成功写盘者因「非最新 gen」而不广播。committedLocaleGen 只被成功提交
// 的调用推进,失败调用不碰它,故不会压掉前一个已成功提交者的广播。
let committedLocaleGen = 0;

export { mapSystemLocale } from '../../shared/i18n-types';
export type { Locale, Settings } from '../../shared/i18n-types';

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultSettings(): Settings {
  let sysLocale: Locale = DEFAULT_SETTINGS.locale;
  try {
    sysLocale = mapSystemLocale(app.getLocale());
  } catch {
    // app 未 ready 时退默认
  }
  return { version: 1, locale: sysLocale };
}

/**
 * 读 settings.json。
 * - 缺文件 → default
 * - 解析失败 → 备份 .corrupt + 重置默认
 * 永远返回有效 Settings；不抛。
 */
export async function loadSettings(): Promise<Settings> {
  return withSettingsMutex(async () => {
    if (cached) return cached;
    const file = settingsFile();
    // 边界(E69,E18/E26/E66/E67/E68 stat-before-read 族;E164 TOCTOU 修正):settings.json 语义只有
    // {version,locale}(~数十字节),加很小的读前大小上限。此前 `fs.stat` 判 size + `fs.readFile` 整文件
    // 两次独立路径解析,检查与读取之间文件可增长/替换绕过上限。改用共享 readFileCappedFd(单 fd
    // open→fstat 同 inode→有界读)。语义保持:超大 = 损坏/恶意 → 当 corrupt 处理(rename .corrupt +
    // 重置默认 + 写 cache,与下方 parse/schema 损坏同型);ENOENT(缺文件=首次启动)→ 默认 + 写 cache;
    // EACCES/EIO「当前态未知」→ 默认但**不写 cache**(否则默认成「当前状态」,saveSettings 会覆盖用户
    // 已存 locale)→ 下次重试。保持「永不抛」启动契约。
    let raw: string;
    try {
      const r = await readFileCappedFd(file, MAX_SETTINGS_FILE_BYTES);
      if (r.tooLarge) {
        try {
          await fs.rename(file, `${file}.corrupt.${Date.now()}`);
        } catch {
          // 忽略:原文件可能无法 rename
        }
        cached = defaultSettings();
        return cached;
      }
      raw = r.text as string; // tooLarge=false 时必为 string
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cached = defaultSettings(); // 缺文件 = 首次启动
        return cached;
      }
      // EACCES/EIO 等「当前态未知」:返回默认但**不写 cache**,下次重试。
      return defaultSettings();
    }
    try {
      const parsed = JSON.parse(raw);
      const validated = SettingsSchema.parse(parsed);
      cached = validated;
      return validated;
    } catch {
      // 文件可读但内容损坏(JSON/schema)→ 备份 .corrupt + 重置默认(既有契约)
      try {
        await fs.rename(file, `${file}.corrupt.${Date.now()}`);
      } catch {
        // 忽略：原文件可能压根没法读
      }
      cached = defaultSettings();
      return cached;
    }
  });
}

/** 写回 settings.json + 更新 cache。 */
export async function saveSettings(next: Settings): Promise<void> {
  return withSettingsMutex(async () => {
    SettingsSchema.parse(next); // 校验
    await atomicWriteJson(settingsFile(), next);
    cached = next;
  });
}

/** 同步读 in-memory cache 当前 locale（先调过 loadSettings 后可用）。 */
export function getCurrentLocale(): Locale {
  if (cached) return cached.locale;
  // 未 hydrate 时 fallback default — 调用方应在 app.whenReady 后先 loadSettings
  return DEFAULT_SETTINGS.locale;
}

/**
 * 设置 locale 并持久化。返回本次调用的 gen（in-flight token，议题 P1-1）。
 * 调用方应在 IPC handler 内对比本调用 gen 与 setLocaleGen，过期 callback 丢弃。
 */
export async function setCurrentLocale(locale: Locale): Promise<number> {
  const gen = ++setLocaleGen;
  await saveSettings({ version: 1, locale });
  return gen;
}

/** 当前 in-flight（已发起）计数；保留导出供既有调用方/测试参考。广播判定改用 commitSetLocaleGen。 */
export function getSetLocaleGen(): number {
  return setLocaleGen;
}

/**
 * race(R36):成功写盘后调用,判定本次是否「最新成功提交」(决定是否广播 + 重建菜单)。
 * gen 严格大于已提交才算最新并推进 committedLocaleGen —— 失败的调用根本不会走到这里(setCurrentLocale
 * 的 saveSettings reject 会上抛),故不会压掉前一个已成功提交者的广播;乱序提交时旧 gen 也不覆盖新。
 */
export function commitSetLocaleGen(gen: number): boolean {
  if (gen <= committedLocaleGen) return false;
  committedLocaleGen = gen;
  return true;
}

/** Test helper — 重置 cache 与 gen 计数；spec setup/teardown 用。 */
export function _resetSettingsForTest(): void {
  cached = null;
  setLocaleGen = 0;
  committedLocaleGen = 0;
  settingsChain = Promise.resolve();
}
