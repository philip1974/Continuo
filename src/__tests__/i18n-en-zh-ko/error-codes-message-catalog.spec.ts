import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

const dictionaries = [
  ['en', en],
  ['zh', zh],
  ['ko', ko],
] as const;

describe('errors.* catalog 全覆盖（从 ERROR_CODES enum 生成断言 — P2-2）', () => {
  Object.values(ERROR_CODES).forEach((code) => {
    it.each(dictionaries)(`locale %s has errors.${code}`, (_, dict) => {
      expect(dict).toHaveProperty(`errors.${code}`);
    });
  });
});
