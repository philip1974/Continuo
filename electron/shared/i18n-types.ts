import { z } from 'zod';

/** 支持的 locale 字面值,zod schema 与 type 都派生自此. */
export const LOCALES = ['en', 'zh', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

/** 单源 zod schema,main IPC + SettingsSchema 都复用. */
export const LocaleSchema = z.enum(LOCALES);

export const LANG_MAP: Record<Locale, string> = {
  en: 'en_US.UTF-8',
  zh: 'zh_CN.UTF-8',
  ko: 'ko_KR.UTF-8',
};

/** 匹配 *.UTF-8 / *.utf8 等 UTF-8 locale 写法。 */
export const UTF8_LANG_RE = /^[A-Za-z_]+\.UTF-?8$/i;

function isAsciiAlphaOrUnderscore(code: number): boolean {
  return (
    code === 95 ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isAsciiLetterIgnoreCase(code: number, lower: number): boolean {
  return (code | 32) === lower;
}

/** 匹配 *.UTF-8 / *.utf8 等 UTF-8 locale 写法。 */
export function isUtf8LangName(lang: string): boolean {
  const len = lang.length;
  let dotIndex = -1;

  if (
    len >= 6 &&
    lang.charCodeAt(len - 5) === 46 &&
    isAsciiLetterIgnoreCase(lang.charCodeAt(len - 4), 117) &&
    isAsciiLetterIgnoreCase(lang.charCodeAt(len - 3), 116) &&
    isAsciiLetterIgnoreCase(lang.charCodeAt(len - 2), 102) &&
    lang.charCodeAt(len - 1) === 56
  ) {
    dotIndex = len - 5;
  } else if (
    len >= 7 &&
    lang.charCodeAt(len - 6) === 46 &&
    isAsciiLetterIgnoreCase(lang.charCodeAt(len - 5), 117) &&
    isAsciiLetterIgnoreCase(lang.charCodeAt(len - 4), 116) &&
    isAsciiLetterIgnoreCase(lang.charCodeAt(len - 3), 102) &&
    lang.charCodeAt(len - 2) === 45 &&
    lang.charCodeAt(len - 1) === 56
  ) {
    dotIndex = len - 6;
  }

  if (dotIndex <= 0) {
    return false;
  }
  for (let i = 0; i < dotIndex; i += 1) {
    if (!isAsciiAlphaOrUnderscore(lang.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

/**
 * 从系统 locale tag (例 'zh-CN', 'ko-KR', 'en-US') 映射到支持的 Locale。
 * 未识别的 → 'en' fallback。
 */
export function mapSystemLocale(sysTag: string | undefined | null): Locale {
  if (!sysTag) return 'en';
  const lower = sysTag.toLowerCase();
  const dash = lower.indexOf('-');
  const head = dash < 0 ? lower : lower.slice(0, dash);
  if (head === 'zh') return 'zh';
  if (head === 'ko') return 'ko';
  return 'en';
}

/** main settings.json schema（v1，仅含 locale 一项）。 */
export const SettingsSchema = z
  .object({
    version: z.literal(1),
    locale: LocaleSchema,
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  locale: 'en',
};
