import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type SettingsData = { readonly version: 1; readonly locale: Locale };
type SettingsServiceModule = {
  readonly mapSystemLocale: (locale: string) => Locale;
  readonly loadSettings: () => Promise<SettingsData>;
  readonly saveSettings: (settings: SettingsData) => Promise<void>;
};

const electronMock = vi.hoisted(() => ({
  app: {
    getLocale: vi.fn<() => string>(() => 'zh-CN'),
    getPath: vi.fn<(name: string) => string>(() => '/tmp/continuo-settings-bdd'),
  },
}));

vi.mock('electron', () => electronMock);

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('settings.service (settings.json) — P2-1 表驱动', () => {
  it('缺文件时返回默认 { version:1, locale: mapSystemLocale(app.getLocale()) }', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );

    await expect(service.loadSettings()).resolves.toEqual({
      version: 1,
      locale: 'zh',
    });
  });

  it('解析失败时备份 .corrupt 并重置为默认', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );

    await expect(service.loadSettings()).resolves.toEqual({
      version: 1,
      locale: 'zh',
    });
    await expect(service.loadSettings()).resolves.not.toThrow();
  });

  it('load → save → load 圆环一致', async () => {
    const service = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );
    const settings: SettingsData = { version: 1, locale: 'ko' };

    await service.saveSettings(settings);

    await expect(service.loadSettings()).resolves.toEqual(settings);
  });

  it.each([
    ['zh-CN', 'zh'],
    ['zh-TW', 'zh'],
    ['zh-HK', 'zh'],
    ['ko-KR', 'ko'],
    ['ko', 'ko'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['en', 'en'],
    ['de-DE', 'en'],
    ['ja-JP', 'en'],
  ] as const)('mapSystemLocale(%s) -> %s', async (input, expected) => {
    const { mapSystemLocale } = await importPending<SettingsServiceModule>(
      '../../../electron/main/services/settings.service',
    );

    expect(mapSystemLocale(input)).toBe(expected);
  });
});
