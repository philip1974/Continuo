import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetMissingKeyWarningsForTest,
  setLocale as setI18nLocale,
  translate,
} from '@/i18n';

afterEach(() => {
  setI18nLocale('en');
  resetMissingKeyWarningsForTest();
  vi.restoreAllMocks();
});

describe('translate() fallback chain + dedup warn', () => {
  it('locale="zh" 拿到 zh 字典命中', () => {
    setI18nLocale('zh');

    expect(translate('common.cancel')).toBe('取消');
  });

  // catalog 完整性强约束:zh/ko 都是 Record<keyof typeof en, string>,
  // 不存在“locale 缺但 en 有”的真实 key；该路径并入 all-missing 覆盖。
  it('三 locale 都缺时返回 key 本身', () => {
    setI18nLocale('ko');

    expect(translate('__test.totally.missing.key')).toBe(
      '__test.totally.missing.key',
    );
  });

  it('DEV 环境同一缺 key 只 warn 一次（去重）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetMissingKeyWarningsForTest();

    setI18nLocale('zh');
    translate('__test.missing.dedup');
    translate('__test.missing.dedup');

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('{paramName} 插值生效', () => {
    setI18nLocale('en');

    expect(translate('errors.FS_NOT_FOUND', { path: '/tmp/a.md' })).toBe(
      'File not found: /tmp/a.md',
    );
  });

  it('有 params 时不通过 Object.keys(params).length 判断是否插值', () => {
    setI18nLocale('en');
    const params = { path: '/tmp/a.md' };
    const keysSpy = vi.spyOn(Object, 'keys');

    try {
      expect(translate('errors.FS_NOT_FOUND', params)).toBe(
        'File not found: /tmp/a.md',
      );
      expect(keysSpy.mock.calls.some(([arg]) => arg === params)).toBe(false);
    } finally {
      keysSpy.mockRestore();
    }
  });
});
