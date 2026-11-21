import { LANG_MAP, isUtf8LangName } from '../../shared/i18n-types';
import type { Locale } from '../../shared/i18n-types';

export function withPtyLangEnv(
  env: Record<string, string | undefined>,
  locale: Locale = 'en',
): Record<string, string | undefined> {
  // 按 POSIX 有效 locale 判断(LC_ALL > LC_CTYPE > LANG,空串视同未设)。旧实现只看
  // LANG:LANG=ja_JP.UTF-8 + LC_ALL=C 时有效字符集仍是 C,却被当成 UTF-8 放行 → CJK 乱码。
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (effective && isUtf8LangName(effective)) {
    return env;
  }
  const lang = LANG_MAP[locale];
  return { ...env, LANG: lang, LC_ALL: lang };
}
