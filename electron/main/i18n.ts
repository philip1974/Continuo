import {
  LOCALE_DICTS,
  hasTranslateParams,
  interpolateTemplate,
  type TranslateParams,
} from '../shared/i18n-interpolate';
import { ownValue } from '../shared/own-value';
import { getCurrentLocale } from './services/settings.service';

export type MainT = (key: string, params?: TranslateParams) => string;

/**
 * main 端用的 translate 工厂 — 返回当前 locale 绑定的 t 函数。
 * 调 buildAppMenu 等需要 t 的场景时调一次拿 t；locale 变更后重调获取新 t。
 *
 * Fallback chain: dicts[currentLocale][key] → dicts.en[key] → key。
 */
export function getMainT(): MainT {
  const locale = getCurrentLocale();
  const dict = LOCALE_DICTS[locale];
  const enDict = LOCALE_DICTS.en;

  return (key, params) => {
    // 只认自有属性(同 renderer translate):key 为原型成员名时不返回函数。
    let template = ownValue(dict, key);
    if (template === undefined) template = ownValue(enDict, key);
    if (template === undefined) return key;
    if (hasTranslateParams(params)) {
      return interpolateTemplate(template, params);
    }
    return template;
  };
}
