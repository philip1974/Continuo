import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type IpcOk<T> = { readonly ok: true; readonly data: T };
type SetLocaleData = { readonly ok: true; readonly locale: Locale; readonly gen: number };
type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (v: T) => void };

type SettingsStoreModule = {
  readonly useSettingsStore: {
    readonly getState: () => {
      readonly locale: Locale;
      readonly currentGen: number;
      readonly setLocale: (locale: Locale) => Promise<void>;
    };
  };
  readonly _resetSettingsStoreForTest: () => void;
};

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const mockCoApi = vi.hoisted(() => ({
  i18n: {
    setLocale: vi.fn<(locale: Locale) => Promise<IpcOk<SetLocaleData>>>(),
    onChange: vi.fn(() => () => undefined),
    getLocale: vi.fn(),
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    i18n: mockCoApi.i18n,
    system: { windowId: 1 },
  },
}));

async function importStore(): Promise<SettingsStoreModule> {
  return import('@/stores/settings.store') as Promise<SettingsStoreModule>;
}

afterEach(async () => {
  const store = await importStore();
  store._resetSettingsStoreForTest();
  vi.clearAllMocks();
});

describe('setLocale in-flight token serialization — P1-1', () => {
  it('两次连发，老 gen 返回到达时被丢弃', async () => {
    const { useSettingsStore } = await importStore();
    const d1 = makeDeferred<IpcOk<SetLocaleData>>();
    const d2 = makeDeferred<IpcOk<SetLocaleData>>();
    mockCoApi.i18n.setLocale.mockImplementationOnce(() => d1.promise);
    mockCoApi.i18n.setLocale.mockImplementationOnce(() => d2.promise);

    const p1 = useSettingsStore.getState().setLocale('zh');
    const p2 = useSettingsStore.getState().setLocale('ko');

    d2.resolve({ ok: true, data: { ok: true, locale: 'ko', gen: 2 } });
    await p2;
    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(useSettingsStore.getState().currentGen).toBe(2);

    d1.resolve({ ok: true, data: { ok: true, locale: 'zh', gen: 1 } });
    await p1;
    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(useSettingsStore.getState().currentGen).toBe(2);
  });
});
