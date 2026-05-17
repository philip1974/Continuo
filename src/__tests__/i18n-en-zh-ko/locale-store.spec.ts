import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type LocaleChange = { readonly locale: Locale; readonly gen: number };
type LocaleChangeHandler = (change: LocaleChange) => void;
type IpcOk<T> = { readonly ok: true; readonly data: T };
type IpcFail = { readonly ok: false; readonly code: string; readonly message: string };
type SetLocaleData = { readonly ok: true; readonly locale: Locale; readonly gen: number };

type SettingsStoreModule = {
  readonly useSettingsStore: {
    readonly getState: () => {
      readonly locale: Locale;
      readonly currentGen: number;
      readonly setLocale: (locale: Locale) => Promise<void>;
    };
    readonly setState: (patch: { locale: Locale; currentGen: number }) => void;
  };
  readonly subscribeToI18nBroadcast: () => void;
  readonly _resetSettingsStoreForTest: () => void;
};

const mockCoApi = vi.hoisted(() => {
  const api = {
    capturedOnChange: undefined as LocaleChangeHandler | undefined,
    unsubscribe: vi.fn(),
    i18n: {
      setLocale:
        vi.fn<(locale: Locale) => Promise<IpcOk<SetLocaleData> | IpcFail>>(),
      onChange: vi.fn<(cb: LocaleChangeHandler) => () => void>(),
      getLocale: vi.fn(),
    },
  };
  api.i18n.onChange.mockImplementation((cb) => {
    api.capturedOnChange = cb;
    return api.unsubscribe;
  });
  return api;
});

vi.mock('@/lib/co-api', () => ({
  coApi: {
    i18n: mockCoApi.i18n,
  },
}));

async function importStore(): Promise<SettingsStoreModule> {
  return import('@/stores/settings.store') as Promise<SettingsStoreModule>;
}

afterEach(async () => {
  const store = await importStore();
  store._resetSettingsStoreForTest();
  mockCoApi.capturedOnChange = undefined;
  vi.clearAllMocks();
});

describe('settings.store + coApi.i18n roundtrip', () => {
  it('setLocale("zh") 调 coApi.i18n.setLocale("zh") 并更新 store', async () => {
    mockCoApi.i18n.setLocale.mockResolvedValue({
      ok: true,
      data: { ok: true, locale: 'zh', gen: 1 },
    });
    const { useSettingsStore } = await importStore();

    await useSettingsStore.getState().setLocale('zh');

    expect(mockCoApi.i18n.setLocale).toHaveBeenCalledWith('zh');
    expect(useSettingsStore.getState().locale).toBe('zh');
    expect(useSettingsStore.getState().currentGen).toBe(1);
  });

  it('subscribeToI18nBroadcast() 挂载后 onChange broadcast 同步 state', async () => {
    const { subscribeToI18nBroadcast, useSettingsStore } = await importStore();

    subscribeToI18nBroadcast();
    mockCoApi.capturedOnChange?.({ locale: 'ko', gen: 1 });

    expect(mockCoApi.i18n.onChange).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(useSettingsStore.getState().currentGen).toBe(1);
  });

  it('currentGen 字段拒绝过期 broadcast', async () => {
    const { subscribeToI18nBroadcast, useSettingsStore } = await importStore();

    useSettingsStore.setState({ locale: 'ko', currentGen: 2 });
    subscribeToI18nBroadcast();
    mockCoApi.capturedOnChange?.({ locale: 'zh', gen: 1 });

    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(useSettingsStore.getState().currentGen).toBe(2);
  });

  it('setLocale 失败时 throw 且保留原 state', async () => {
    mockCoApi.i18n.setLocale.mockResolvedValue({
      ok: false,
      code: 'I18N_SET_FAILED',
      message: 'write failed',
    });
    const { useSettingsStore } = await importStore();

    await expect(useSettingsStore.getState().setLocale('zh')).rejects.toThrow(
      'setLocale failed: code=I18N_SET_FAILED message=write failed',
    );
    expect(useSettingsStore.getState().locale).toBe('en');
    expect(useSettingsStore.getState().currentGen).toBe(0);
  });
});
