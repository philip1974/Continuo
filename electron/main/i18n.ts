import { en } from '../shared/i18n-locales/en';
import { zh } from '../shared/i18n-locales/zh';
import { ko } from '../shared/i18n-locales/ko';
import type { Locale } from '../shared/i18n-types';
import { getCurrentLocale } from './services/settings.service';

const DICTS: Record<Locale, Record<string, string>> = {
  en,
  zh,
  ko,
};

export type TranslateParams = Readonly<Record<string, string | number>>;
export type MainT = (key: string, params?: TranslateParams) => string;

const hasOwn = Object.prototype.hasOwnProperty;

function hasParams(params: TranslateParams | undefined): params is TranslateParams {
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

/**
 * main 端用的 translate 工厂 — 返回当前 locale 绑定的 t 函数。
 * 调 buildMenuTemplate 等需要 t 的场景时调一次拿 t；locale 变更后重调获取新 t。
 *
 * Fallback chain: dicts[currentLocale][key] → dicts.en[key] → key。
 */
export function getMainT(): MainT {
  const locale = getCurrentLocale();
  const dict = DICTS[locale];
  const enDict = DICTS.en;

  return (key, params) => {
    let template = dict[key];
    if (template === undefined) template = enDict[key];
    if (template === undefined) return key;
    if (hasParams(params)) {
      return interpolateTemplate(template, params);
    }
    return template;
  };
}
