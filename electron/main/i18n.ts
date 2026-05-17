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
    if (params && Object.keys(params).length > 0) {
      return template.replace(/\{(\w+)\}/g, (m, name) => {
        const v = params[name];
        return v === undefined ? m : String(v);
      });
    }
    return template;
  };
}
