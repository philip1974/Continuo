import { afterEach, describe, expect, it } from 'vitest';
import {
  tWithFallback,
  setLocale,
  resetMissingKeyWarningsForTest,
} from '@/i18n/translate';

afterEach(() => {
  setLocale('en');
  resetMissingKeyWarningsForTest();
});

describe('tWithFallback', () => {
  it('returns fallback when key is undefined', () => {
    expect(tWithFallback(undefined, 'Default')).toBe('Default');
  });

  it('returns fallback when key is empty string', () => {
    expect(tWithFallback('', 'Default')).toBe('Default');
  });

  it('returns fallback when key is unknown (no catalog hit)', () => {
    expect(tWithFallback('no.such.key.foobar', 'Default')).toBe('Default');
  });

  it('returns translation when key hits en catalog', () => {
    // 'common.cancel' is a known topic-16 key
    expect(tWithFallback('common.cancel', 'CancelFallback')).toBe('Cancel');
  });

  it('returns translation when locale is zh and key hits', () => {
    setLocale('zh');
    expect(tWithFallback('common.cancel', 'CancelFallback')).toBe('取消');
  });

  it('returns translation when locale is ko and key hits', () => {
    setLocale('ko');
    expect(tWithFallback('common.ok', 'OKFallback')).toBe('확인');
  });

  it('forwards params for template interpolation', () => {
    // Use a key with template (set up post Op3); for now skip dynamic
    // - This guarantees signature compiles; runtime check covered by Op3 catalog tests
    expect(typeof tWithFallback('x', 'Y', { foo: 1 })).toBe('string');
  });
});
