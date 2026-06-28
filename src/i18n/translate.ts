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

function hasOwnParam(params: TranslateParams): boolean {
  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return true;
    }
  }
  return false;
}

function isTemplateParamChar(code: number): boolean {
  return (
    code === 95 ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function interpolateTemplate(template: string, params: TranslateParams): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < template.length - 2; i += 1) {
    if (template.charCodeAt(i) !== 123) continue;
    let end = i + 1;
    if (!isTemplateParamChar(template.charCodeAt(end))) continue;
    end += 1;
    while (end < template.length && isTemplateParamChar(template.charCodeAt(end))) {
      end += 1;
    }
    if (template.charCodeAt(end) !== 125) {
      i = end;
      continue;
    }
    const name = template.slice(i + 1, end);
    const original = template.slice(i, end + 1);
    const value = params[name];
    out += template.slice(last, i);
    out += value === undefined ? original : String(value);
    last = end + 1;
    i = end;
  }
  if (last === 0) return template;
  return out + template.slice(last);
}

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
       
      console.warn('[i18n] missing key:', key);
    }
    return key;
  }

  // 简单 {paramName} 插值
  if (params && hasOwnParam(params)) {
    return interpolateTemplate(template, params);
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
