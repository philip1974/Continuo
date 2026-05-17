import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

type Locale = 'en' | 'zh' | 'ko';
type CatalogModule = {
  readonly dictionaries: Readonly<Record<Locale, Readonly<Record<string, string>>>>;
};

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

describe('errors.* catalog 全覆盖（从 ERROR_CODES enum 生成断言 — P2-2）', () => {
  Object.values(ERROR_CODES).forEach((code) => {
    it(`errors.${code} exists in en/zh/ko`, async () => {
      const { dictionaries } = await importPending<CatalogModule>(
        '@/i18n/catalog',
      );

      for (const locale of ['en', 'zh', 'ko'] as const) {
        expect(dictionaries[locale]).toHaveProperty(`errors.${code}`);
      }
    });
  });
});
