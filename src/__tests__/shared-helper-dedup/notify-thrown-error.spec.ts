// 重构守卫:catch 分支「取 code → 本地化 → notify.error」样板收口到 errorCodeOf / notifyThrownError。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }));
vi.mock('../../notifications/notify', () => ({ notify: { error: errorSpy } }));

import { errorCodeOf } from '../../../electron/shared/error-message';
import { notifyThrownError } from '../../notifications/notify-thrown-error';
import { setLocale } from '../../i18n/translate';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

beforeEach(() => {
  errorSpy.mockClear();
  setLocale('en');
});
afterEach(() => setLocale('en'));

describe('errorCodeOf', () => {
  it('带 code 的抛出值 → 该 code;否则 EXCEPTION', () => {
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'FS_DENIED' }))).toBe('FS_DENIED');
    expect(errorCodeOf({ code: 'E1' })).toBe('E1');
    expect(errorCodeOf(new Error('plain'))).toBe('EXCEPTION');
    expect(errorCodeOf('string thrown')).toBe('EXCEPTION');
    expect(errorCodeOf(null)).toBe('EXCEPTION');
    expect(errorCodeOf(undefined)).toBe('EXCEPTION');
  });
});

describe('notifyThrownError', () => {
  it('catalog 收录的 code → 本地化文案 + 附 code', () => {
    notifyThrownError(Object.assign(new Error('raw main message'), { code: 'FS_DENIED' }));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, opts] = errorSpy.mock.calls[0]!;
    expect(opts).toEqual({ code: 'FS_DENIED' });
    expect(message).not.toBe('raw main message');
    expect(typeof message).toBe('string');
  });

  it('未收录的 code → 回退原 message', () => {
    notifyThrownError(Object.assign(new Error('network down'), { code: 'SOME_DYNAMIC_CODE' }));
    expect(errorSpy).toHaveBeenCalledWith('network down', { code: 'SOME_DYNAMIC_CODE' });
  });

  it('无 code 的 Error → code=EXCEPTION,文案为原 message', () => {
    notifyThrownError(new Error('boom'));
    expect(errorSpy).toHaveBeenCalledWith('boom', { code: 'EXCEPTION' });
  });

  it('抛出值无 message(非 Error)→ 回退 code,不弹空 toast', () => {
    notifyThrownError(undefined);
    expect(errorSpy).toHaveBeenCalledWith('EXCEPTION', { code: 'EXCEPTION' });
  });
});

describe('接线守卫:renderer 不再手写错误码提取', () => {
  it("src 下无 `?.code ?? 'EXCEPTION'` 内联副本(errorCodeOf 定义在 electron/shared/error-message)", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      if (/\?\.code \?\? 'EXCEPTION'/.test(readFileSync(file, 'utf-8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
