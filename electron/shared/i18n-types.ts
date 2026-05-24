import { z } from 'zod';

export type Locale = 'en' | 'zh' | 'ko';

export const LANG_MAP: Record<Locale, string> = {
  en: 'en_US.UTF-8',
  zh: 'zh_CN.UTF-8',
  ko: 'ko_KR.UTF-8',
};

/** 匹配 *.UTF-8 / *.utf8 等 UTF-8 locale 写法。 */
export const UTF8_LANG_RE = /^[A-Za-z_]+\.UTF-?8$/i;

/**
 * 从系统 locale tag (例 'zh-CN', 'ko-KR', 'en-US') 映射到支持的 Locale。
 * 未识别的 → 'en' fallback。
 */
export function mapSystemLocale(sysTag: string | undefined | null): Locale {
  if (!sysTag) return 'en';
  const head = sysTag.toLowerCase().split('-')[0];
  if (head === 'zh') return 'zh';
  if (head === 'ko') return 'ko';
  return 'en';
}

/** main settings.json schema（v1，仅含 locale 一项）。 */
export const SettingsSchema = z
  .object({
    version: z.literal(1),
    locale: z.enum(['en', 'zh', 'ko']),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  locale: 'en',
};
