import type { en } from '@shared/i18n-locales/en';
import {
  LOCALE_DICTS,
  hasTranslateParams,
  interpolateTemplate,
  type TranslateParams,
} from '@shared/i18n-interpolate';
import type { Locale } from '@shared/i18n-types';
import { ownValue } from '@shared/own-value';
import { isLinuxRuntime, isWindowsRuntime } from '@/lib/path-cross';

export type { Locale } from '@shared/i18n-types';
export type { TranslateParams } from '@shared/i18n-interpolate';

/** 翻译 key 联合类型 — en 是 type source（v3 P0-1 + P2-2）。 */
export type TranslationKey = keyof typeof en;

/** module-level locale state — useT 与 t 都读这里；settings.store 启动后会 setLocale 同步真值。 */
let currentLocale: Locale = 'en';

/** 用于 missing-key warning 去重（议题 P2-3 + plan-v3 Op4） */
const missingWarned = new Set<string>();

export function getLocale(): Locale {
  return currentLocale;
}

/** 界面语言 → BCP 47 语言标签(写到 <html lang>)。 */
const HTML_LANG: Record<Locale, string> = { en: 'en', zh: 'zh-CN', ko: 'ko' };

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  // <html lang> 跟随界面语言:读屏按它选发音,CSS `:lang(ko)` 据此让韩文按词断行(theme.css)。
  if (typeof document !== 'undefined') document.documentElement.lang = HTML_LANG[locale];
}

/**
 * 翻译 fallback chain: dicts[locale][key] → dicts.en[key] → key 本身。
 * 缺 key 在 DEV 环境一次性 warn（去重）。
 */
export function translate(
  key: string,
  params?: TranslateParams,
): string {
  const dict = LOCALE_DICTS[currentLocale];
  const enDict = LOCALE_DICTS.en;

  // 只认自有属性:插件 titleKey 为 constructor / toString 等时不得命中 Object.prototype 返回函数。
  let template = ownValue(dict, key);
  if (template === undefined) template = ownValue(enDict, key);

  if (template === undefined) {
    if (import.meta.env?.DEV && !missingWarned.has(key)) {
      missingWarned.add(key);
       
      console.warn('[i18n] missing key:', key);
    }
    return key;
  }

  // 简单 {paramName} 插值
  if (hasTranslateParams(params)) {
    return interpolateTemplate(template, params);
  }

  return template;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/**
 * 计数文案:按当前语言的复数规则(Intl.PluralRules)选 `<baseKey>_one` / `<baseKey>_other`,以 `{count}` 插值。
 * 只区分 one / other 两类(en:1 line / 2 lines;zh / ko 规则恒为 other,两 key 同文)。仓库 i18n 无复数机制,此为最小实现。
 */
export function translateCount(baseKey: string, count: number): string {
  let rules = pluralRules.get(currentLocale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(HTML_LANG[currentLocale]);
    pluralRules.set(currentLocale, rules);
  }
  return translate(`${baseKey}_${rules.select(count) === 'one' ? 'one' : 'other'}`, { count });
}

/** Spec helper — 重置 DEV warn 去重集合，便于测试断言"只 warn 一次"。 */
export function resetMissingKeyWarningsForTest(): void {
  missingWarned.clear();
}

/**
 * 按运行平台选文案变体(VSCode 按 isWindows / isMacintosh 选文案,如 REVEAL_IN_OS_LABEL「Reveal in File Explorer / Reveal in Finder /
 * Open Containing Folder」、删除确认的 Recycle Bin / Trash):Windows → `<key>_win`、Linux → `<key>_linux`(en catalog 有该变体时),
 * 否则原 key —— 基础文案是 macOS 措辞(平台无法识别时也用它)。BDD: src/__tests__/win-linux-parity/
 */
export function osVariantKey(key: TranslationKey): TranslationKey {
  const suffix = isWindowsRuntime() ? '_win' : isLinuxRuntime() ? '_linux' : null;
  if (suffix === null) return key;
  const variant = `${key}${suffix}`;
  return ownValue(LOCALE_DICTS.en, variant) === undefined ? key : (variant as TranslationKey);
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

/**
 * 同 tWithFallback,但固定取英文(en catalog;缺 key 用 fallback —— 约定 CommandSpec 的 title / category 是英文 fallback)。
 * 本地化界面下命令面板 / 快捷键设置按英文原名搜索用(VSCode commandAlias)。
 */
export function englishWithFallback(key: string | undefined, fallback: string): string {
  if (key === undefined || key === '') return fallback;
  return ownValue(LOCALE_DICTS.en, key) ?? fallback;
}
