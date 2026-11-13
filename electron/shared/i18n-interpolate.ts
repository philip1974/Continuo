// i18n 字典 + `{param}` 模板插值的跨进程单一来源(重构:renderer src/i18n/translate.ts 与 main
// electron/main/i18n.ts 此前各持一份逐字相同的 DICTS / hasOwn 参数探测 / interpolateTemplate)。
// 两端只保留各自的 locale 来源与 missing-key 策略(renderer DEV warn;main 静默回 key)。

import { en } from './i18n-locales/en';
import { zh } from './i18n-locales/zh';
import { ko } from './i18n-locales/ko';
import type { Locale } from './i18n-types';

export type TranslateParams = Readonly<Record<string, string | number>>;

export const LOCALE_DICTS: Record<Locale, Record<string, string>> = {
  en,
  zh,
  ko,
};

const hasOwn = Object.prototype.hasOwnProperty;

/** params 至少有一个自有可枚举键(空对象 / undefined 不值得走插值扫描)。 */
export function hasTranslateParams(
  params: TranslateParams | undefined,
): params is TranslateParams {
  if (!params) return false;
  for (const key in params) {
    if (hasOwn.call(params, key)) return true;
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

/**
 * 简单 `{paramName}` 插值(paramName = [A-Za-z0-9_]+)。params 缺该名 → 保留原占位符;
 * 无任何占位符 → 原样返回同一字符串。
 */
export function interpolateTemplate(template: string, params: TranslateParams): string {
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
