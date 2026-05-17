import { LANG_MAP, UTF8_LANG_RE } from '../../shared/i18n-types';
import type { Locale } from '../../shared/i18n-types';

export { LANG_MAP } from '../../shared/i18n-types';

export function withPtyLangEnv(
  env: Record<string, string | undefined>,
  locale: Locale = 'en',
): Record<string, string | undefined> {
  const current = env.LANG;
  if (current && UTF8_LANG_RE.test(current)) {
    return env;
  }
  const lang = LANG_MAP[locale];
  return { ...env, LANG: lang, LC_ALL: lang };
}
