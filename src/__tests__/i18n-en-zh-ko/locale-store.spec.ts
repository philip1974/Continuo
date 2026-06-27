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

  // 边界(E170,E168/E169 同族 IPC ingress 纵深防御):畸形 i18n:changed 广播 payload → drop + warn,
  // 不更新 store/module locale(防 catalog 不存在的 locale 致 translate() DICTS[locale] undefined 崩溃,
  // 及 NaN gen 污染乱序保护)。
  it('E170 畸形 broadcast(非法 locale / NaN gen / null / 非对象 / 负 gen)→ drop,state 不变', () => {
    return importStore().then(({ subscribeToI18nBroadcast, useSettingsStore }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      useSettingsStore.setState({ locale: 'en', currentGen: 5 });
      subscribeToI18nBroadcast();
      const fire = mockCoApi.capturedOnChange as ((p: unknown) => void) | undefined;
      const bad: unknown[] = [
        null,
        'string',
        { locale: 'fr', gen: 9 }, // catalog 不存在的 locale
        { locale: 'en', gen: Number.NaN }, // NaN gen
        { locale: 'en', gen: Infinity }, // Infinity gen
        { locale: 'en', gen: 6.5 }, // 非整数 gen
        { locale: 'en', gen: -1 }, // 负 gen
        { locale: 123, gen: 9 }, // locale 非字符串
        { gen: 9 }, // 缺 locale
      ];
      for (const p of bad) fire?.(p);
      // state 保持初始(未被任何畸形广播污染)
      expect(useSettingsStore.getState().locale).toBe('en');
      expect(useSettingsStore.getState().currentGen).toBe(5);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it('E170 合规 broadcast(locale ∈ catalog,gen 安全整数)→ 正常更新(回归)', () => {
    return importStore().then(({ subscribeToI18nBroadcast, useSettingsStore }) => {
      subscribeToI18nBroadcast();
      mockCoApi.capturedOnChange?.({ locale: 'zh', gen: 3 });
      expect(useSettingsStore.getState().locale).toBe('zh');
      expect(useSettingsStore.getState().currentGen).toBe(3);
    });
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
