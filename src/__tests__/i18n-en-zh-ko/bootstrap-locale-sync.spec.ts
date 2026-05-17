import { describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type BootstrapApi = {
  readonly coApi: {
    readonly i18n: {
      readonly getLocale: () => Promise<Locale>;
    };
  };
  readonly settingsStore: {
    readonly setLocaleFromMain: (locale: Locale) => void;
    readonly getState: () => { readonly locale: Locale };
  };
  readonly bootCorePlugins: () => void;
};

type BootstrapModule = {
  readonly bootstrapRenderer: (api: BootstrapApi) => Promise<void>;
};

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

describe('renderer bootstrap locale sync — P0-2', () => {
  it('await coApi.i18n.getLocale() 完成后 useSettingsStore.locale === main 真值', async () => {
    let locale: Locale = 'en';
    const api: BootstrapApi = {
      coApi: {
        i18n: {
          getLocale: vi.fn<() => Promise<Locale>>(async () => 'zh'),
        },
      },
      settingsStore: {
        setLocaleFromMain: (next) => {
          locale = next;
        },
        getState: () => ({ locale }),
      },
      bootCorePlugins: vi.fn(),
    };
    const { bootstrapRenderer } = await importPending<BootstrapModule>(
      '@/bootstrap/renderer',
    );

    await bootstrapRenderer(api);

    expect(api.settingsStore.getState().locale).toBe('zh');
  });

  it('await locale 在 bootCorePlugins 之前调（顺序断言）', async () => {
    const order: string[] = [];
    const api: BootstrapApi = {
      coApi: {
        i18n: {
          getLocale: vi.fn<() => Promise<Locale>>(async () => {
            order.push('getLocale');
            return 'zh';
          }),
        },
      },
      settingsStore: {
        setLocaleFromMain: (locale) => {
          order.push(`set:${locale}`);
        },
        getState: () => ({ locale: 'zh' }),
      },
      bootCorePlugins: vi.fn(() => {
        order.push('bootCorePlugins');
      }),
    };
    const { bootstrapRenderer } = await importPending<BootstrapModule>(
      '@/bootstrap/renderer',
    );

    await bootstrapRenderer(api);

    expect(order).toEqual(['getLocale', 'set:zh', 'bootCorePlugins']);
  });
});
