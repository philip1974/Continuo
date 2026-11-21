// renderer i18n 公共出口 — 业务代码常用 `import { t, useT } from '@/i18n'`。
export { t, translate, tWithFallback, setLocale, getLocale, resetMissingKeyWarningsForTest, type TranslationKey, type TranslateParams, type Locale } from './translate';
export { useT, useLocale, useTWithFallback, notifyLocaleChange } from './react';
