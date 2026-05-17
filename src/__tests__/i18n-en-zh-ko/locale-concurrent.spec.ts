import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type LocaleChange = { readonly locale: Locale; readonly gen: number };
type LocaleChangeHandler = (change: LocaleChange) => void;
type SettingsState = {
  readonly locale: Locale;
  readonly currentGen: number;
  readonly setLocale: (locale: Locale) => Promise<void>;
  readonly applyLocaleBroadcast: (change: LocaleChange) => void;
};
type SettingsStoreModule = {
  readonly useSettingsStore: {
    readonly getState: () => SettingsState;
    readonly setState: (patch: Partial<SettingsState>) => void;
  };
};

const mockCoApi = vi.hoisted(() => ({
  i18n: {
    setLocale: vi.fn<(locale: Locale) => Promise<void>>(),
    onChange: vi.fn<(cb: LocaleChangeHandler) => () => void>(),
  },
}));

vi.mock('@/lib/co-api', () => ({ coApi: mockCoApi }));

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('setLocale in-flight token serialization — P1-1', () => {
  it('快速连续两次 setLocale("zh") 与 setLocale("ko")，老 gen broadcast 被丢弃', async () => {
    const { useSettingsStore } = await importPending<SettingsStoreModule>(
      '@/stores/settings.store',
    );
    mockCoApi.i18n.setLocale.mockResolvedValue(undefined);

    const first = useSettingsStore.getState().setLocale('zh');
    const second = useSettingsStore.getState().setLocale('ko');
    await Promise.all([first, second]);
    useSettingsStore
      .getState()
      .applyLocaleBroadcast({ locale: 'zh', gen: 1 });
    useSettingsStore
      .getState()
      .applyLocaleBroadcast({ locale: 'ko', gen: 2 });

    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(useSettingsStore.getState().currentGen).toBe(2);
  });

  it('最终 store state 与最后一次 setLocale 一致', async () => {
    const { useSettingsStore } = await importPending<SettingsStoreModule>(
      '@/stores/settings.store',
    );
    mockCoApi.i18n.setLocale.mockImplementation(async () => undefined);

    await useSettingsStore.getState().setLocale('zh');
    await useSettingsStore.getState().setLocale('ko');

    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(mockCoApi.i18n.setLocale).toHaveBeenLastCalledWith('ko');
  });
});
