import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import type { Locale } from '@shared/i18n-types';

export type { Locale } from '@shared/i18n-types';

/** 翻译 key 联合类型 — en 是 type source（v3 P0-1 + P2-2）。 */
export type TranslationKey = keyof typeof en;

export type TranslateParams = Readonly<Record<string, string | number>>;

const DICTS: Record<Locale, Record<string, string>> = {
  en,
  zh,
  ko,
};

/** module-level locale state — useT 与 t 都读这里；settings.store 启动后会 setLocale 同步真值。 */
let currentLocale: Locale = 'en';

/** 用于 missing-key warning 去重（议题 P2-3 + plan-v3 Op4） */
const missingWarned = new Set<string>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

/**
 * 翻译 fallback chain: dicts[locale][key] → dicts.en[key] → key 本身。
 * 缺 key 在 DEV 环境一次性 warn（去重）。
 */
export function translate(
  key: string,
  params?: TranslateParams,
): string {
  const dict = DICTS[currentLocale];
  const enDict = DICTS.en;

  let template = dict[key];
  if (template === undefined) template = enDict[key];

  if (template === undefined) {
    if (import.meta.env?.DEV && !missingWarned.has(key)) {
      missingWarned.add(key);
      // eslint-disable-next-line no-console
      console.warn('[i18n] missing key:', key);
    }
    return key;
  }

  // 简单 {paramName} 插值
  if (params && Object.keys(params).length > 0) {
    return template.replace(/\{(\w+)\}/g, (m, name) => {
      const v = params[name];
      return v === undefined ? m : String(v);
    });
  }

  return template;
}

/** Spec helper — 重置 DEV warn 去重集合，便于测试断言"只 warn 一次"。 */
export function resetMissingKeyWarningsForTest(): void {
  missingWarned.clear();
}

/** 非 React 处调用（设置项、main throw 站点的 catalog lookup 等） — 等价 translate 别名。 */
export const t = translate;

/**
 * key 存在则返回翻译；缺 key（或 key 为 undefined）返回 fallback。
 * 解决 useT()(spec.titleKey ?? spec.title) 在缺 key 时显示 key 字面量的问题（topic-19 P0-1）。
 */
export function tWithFallback(
  key: string | undefined,
  fallback: string,
  params?: TranslateParams,
): string {
  if (key === undefined || key === '') return fallback;
  const r = translate(key, params);
  return r === key ? fallback : r;
}
