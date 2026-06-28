import { LANG_MAP, isUtf8LangName } from '../../shared/i18n-types';
import type { Locale } from '../../shared/i18n-types';

export { LANG_MAP } from '../../shared/i18n-types';

export function withPtyLangEnv(
  env: Record<string, string | undefined>,
  locale: Locale = 'en',
): Record<string, string | undefined> {
  const current = env.LANG;
  if (current && isUtf8LangName(current)) {
    return env;
  }
  const lang = LANG_MAP[locale];
  return { ...env, LANG: lang, LC_ALL: lang };
}
