import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../lib/atomic-write';
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  mapSystemLocale,
  type Locale,
  type Settings,
} from '../../shared/i18n-types';

// settings.service 内部 mutex，独立于 explorer 文件锁。
let settingsChain: Promise<unknown> = Promise.resolve();
async function withSettingsMutex<T>(fn: () => Promise<T>): Promise<T> {
  const result = settingsChain.then(fn, fn);
  settingsChain = result.catch(() => undefined);
  return result;
}

let cached: Settings | null = null;
let setLocaleGen = 0;

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
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      const validated = SettingsSchema.parse(parsed);
      cached = validated;
      return validated;
    } catch (err) {
      // file not exist → default
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'ENOENT'
      ) {
        cached = defaultSettings();
        return cached;
      }
      // 解析失败 → 备份原文件
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

/** 当前 in-flight 计数；外部对比用（typically Op8 i18n.ipc setLocale handler 在 saveSettings 完成后比对，过期则不广播）。 */
export function getSetLocaleGen(): number {
  return setLocaleGen;
}

/** Test helper — 重置 cache 与 gen 计数；spec setup/teardown 用。 */
export function _resetSettingsForTest(): void {
  cached = null;
  setLocaleGen = 0;
  settingsChain = Promise.resolve();
}
