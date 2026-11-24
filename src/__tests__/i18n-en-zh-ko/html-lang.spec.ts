// @vitest-environment jsdom
// <html lang> 随界面语言切换:读屏按 lang 选发音,CSS `:lang(ko)` 据此给韩文按词断行(word-break: keep-all,
// 不在词中间换行)。此前 index.html 写死 lang="zh-CN",英文 / 韩文界面也被当成中文。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, setLocale } from '../../i18n';

describe('<html lang> 随界面语言', () => {
  const original = getLocale();
  afterEach(() => setLocale(original));

  it.each([
    ['en', 'en'],
    ['zh', 'zh-CN'],
    ['ko', 'ko'],
  ] as const)('setLocale(%s) → <html lang="%s">', (locale, lang) => {
    setLocale(locale);
    expect(document.documentElement.lang).toBe(lang);
  });

  it('韩文界面按词断行:theme.css 对 :lang(ko) 设 word-break: keep-all', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/theme.css'), 'utf8');
    expect(css).toMatch(/:lang\(ko\)\s*\{[^}]*word-break:\s*keep-all/);
  });
});
