import { describe, expect, it } from 'vitest';
import { toError } from '../error-message';

describe('toError', () => {
  it('Error 原样返回(保留身份与子类)', () => {
    const e = new TypeError('x');
    expect(toError(e)).toBe(e);
  });

  it('非 Error → new Error(String(v))', () => {
    const e = toError('boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('boom');
    expect(toError(null).message).toBe('null');
    expect(toError({ a: 1 }).message).toBe('[object Object]');
  });
});
