import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type LocaleChange = { readonly locale: Locale; readonly gen: number };
type LocaleChangeHandler = (change: LocaleChange) => void;

type SettingsState = {
  readonly locale: Locale;
  readonly currentGen: number;
  readonly setLocale: (locale: Locale) => Promise<void>;
  readonly bindI18n?: () => () => void;
  readonly applyLocaleBroadcast?: (change: LocaleChange) => void;
};

type SettingsStoreModule = {
  readonly useSettingsStore: {
    getState: () => SettingsState;
    setState: (patch: Partial<SettingsState>) => void;
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

describe('settings.store + coApi.i18n roundtrip', () => {
  it('setLocale("zh") 调 coApi.i18n.setLocale("zh") 并更新 store', async () => {
    mockCoApi.i18n.setLocale.mockResolvedValue(undefined);
    const { useSettingsStore } = await importPending<SettingsStoreModule>(
      '@/stores/settings.store',
    );

    await useSettingsStore.getState().setLocale('zh');

    expect(mockCoApi.i18n.setLocale).toHaveBeenCalledWith('zh');
    expect(useSettingsStore.getState().locale).toBe('zh');
  });

  it('订阅 coApi.i18n.onChange 后 state 同步', async () => {
    let onChange: LocaleChangeHandler | undefined;
    mockCoApi.i18n.onChange.mockImplementation((cb) => {
      onChange = cb;
      return () => undefined;
    });
    const { useSettingsStore } = await importPending<SettingsStoreModule>(
      '@/stores/settings.store',
    );

    useSettingsStore.getState().bindI18n?.();
    onChange?.({ locale: 'ko', gen: 1 });

    expect(useSettingsStore.getState().locale).toBe('ko');
  });

  it('currentGen 字段拒绝过期 broadcast', async () => {
    const { useSettingsStore } = await importPending<SettingsStoreModule>(
      '@/stores/settings.store',
    );

    useSettingsStore.setState({ locale: 'ko', currentGen: 2 });
    useSettingsStore
      .getState()
      .applyLocaleBroadcast?.({ locale: 'zh', gen: 1 });

    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(useSettingsStore.getState().currentGen).toBe(2);
  });
});
