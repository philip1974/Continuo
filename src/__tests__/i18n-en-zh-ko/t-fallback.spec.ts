import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type TranslateParams = Readonly<Record<string, string | number>>;
type TranslateModule = {
  readonly setLocale: (locale: Locale) => void;
  readonly translate: (key: string, params?: TranslateParams) => string;
  readonly resetMissingKeyWarningsForTest?: () => void;
};

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('translate() fallback chain + dedup warn', () => {
  it('locale="zh" 拿到 zh 字典命中', async () => {
    const i18n = await importPending<TranslateModule>('@/i18n/translate');

    i18n.setLocale('zh');

    expect(i18n.translate('settings.general.title')).toBe('通用');
  });

  it('缺 key 时 fallback en', async () => {
    const i18n = await importPending<TranslateModule>('@/i18n/translate');

    i18n.setLocale('ko');

    expect(i18n.translate('settings.experimental.onlyEn')).toBe(
      'Experimental',
    );
  });

  it('缺 en 也缺时返回 key 本身', async () => {
    const i18n = await importPending<TranslateModule>('@/i18n/translate');

    i18n.setLocale('zh');

    expect(i18n.translate('missing.everywhere')).toBe('missing.everywhere');
  });

  it('DEV 环境同一缺 key 只 warn 一次（去重）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const i18n = await importPending<TranslateModule>('@/i18n/translate');
    i18n.resetMissingKeyWarningsForTest?.();

    i18n.setLocale('ko');
    i18n.translate('missing.dedup');
    i18n.translate('missing.dedup');

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('{paramName} 插值生效', async () => {
    const i18n = await importPending<TranslateModule>('@/i18n/translate');

    i18n.setLocale('en');

    expect(i18n.translate('errors.FS_NOT_FOUND', { path: '/tmp/a.md' })).toBe(
      'File not found: /tmp/a.md',
    );
  });
});
