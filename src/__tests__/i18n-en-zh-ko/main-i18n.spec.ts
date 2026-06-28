import { describe, expect, it, vi } from 'vitest';

const settingsMock = vi.hoisted(() => ({
  getCurrentLocale: vi.fn(() => 'en' as const),
}));

vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: settingsMock.getCurrentLocale,
}));

describe('main i18n translate', () => {
  it('空 params 不通过 Object.keys 判断非空', async () => {
    const { getMainT } = await import('../../../electron/main/i18n');
    const keysSpy = vi.spyOn(Object, 'keys');

    try {
      const t = getMainT();

      expect(t('shell.tab.close', {})).toBe('Close {title}');
      expect(keysSpy).not.toHaveBeenCalled();
    } finally {
      keysSpy.mockRestore();
    }
  });

  it('有 params 时仍替换模板变量', async () => {
    const { getMainT } = await import('../../../electron/main/i18n');
    const t = getMainT();

    expect(t('shell.tab.close', { title: 'README.md' })).toBe(
      'Close README.md',
    );
  });

  it('模板插值走字符扫描,不调用 String.replace', async () => {
    const { getMainT } = await import('../../../electron/main/i18n');
    const replaceSpy = vi.spyOn(String.prototype, 'replace');

    try {
      const t = getMainT();
      expect(t('shell.tab.close', { title: 'README.md' })).toBe(
        'Close README.md',
      );
      expect(replaceSpy).not.toHaveBeenCalled();
    } finally {
      replaceSpy.mockRestore();
    }
  });
});
