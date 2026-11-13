import {
  LOCALE_DICTS,
  hasTranslateParams,
  interpolateTemplate,
  type TranslateParams,
} from '../shared/i18n-interpolate';
import { getCurrentLocale } from './services/settings.service';

export type { TranslateParams } from '../shared/i18n-interpolate';
export type MainT = (key: string, params?: TranslateParams) => string;

/**
 * main 端用的 translate 工厂 — 返回当前 locale 绑定的 t 函数。
 * 调 buildMenuTemplate 等需要 t 的场景时调一次拿 t；locale 变更后重调获取新 t。
 *
 * Fallback chain: dicts[currentLocale][key] → dicts.en[key] → key。
 */
export function getMainT(): MainT {
  const locale = getCurrentLocale();
  const dict = LOCALE_DICTS[locale];
  const enDict = LOCALE_DICTS.en;

  return (key, params) => {
    let template = dict[key];
    if (template === undefined) template = enDict[key];
    if (template === undefined) return key;
    if (hasTranslateParams(params)) {
      return interpolateTemplate(template, params);
    }
    return template;
  };
}
