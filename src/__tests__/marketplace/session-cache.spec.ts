// @vitest-environment jsdom
// 边界(E71,E70 sessionStorage 孪生):createSessionCache 的 validate 在 JSON.parse 后才生效,
// 挡不住解析前成本。被篡改/旧残留的超大 sessionStorage 缓存会在 Marketplace 打开时阻塞 renderer。
// readStorage 先按原始串长度 cap 拦,超限 → cache-miss + removeItem(清毒)。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionCache } from '../../marketplace/session-cache';

const KEY = 'test.session.cache';
const isStrArr = (d: unknown): d is string[] =>
  Array.isArray(d) && d.every((x) => typeof x === 'string');

beforeEach(() => {
  sessionStorage.clear();
});

describe('createSessionCache 原始串长度上限 (E71)', () => {
  it('正常大小缓存 → 正常 hydrate(往返)', () => {
    const c = createSessionCache<string[]>({ key: KEY, ttlMs: 60_000, validate: isStrArr });
    c.set(['a', 'b']);
    // 新实例(清 memory),强制从 sessionStorage hydrate
    const c2 = createSessionCache<string[]>({ key: KEY, ttlMs: 60_000, validate: isStrArr });
    expect(c2.getFresh()).toEqual(['a', 'b']);
  });

  it('显式 maxRawLength 超限 → cache-miss(解析前拦)且清毒 removeItem', () => {
    // 盘上是合法 wrapper,但原始串超 maxRawLength → 解析前拦
    const wrapped = JSON.stringify({ fetchedAt: Date.now(), data: ['x'.repeat(200)] });
    sessionStorage.setItem(KEY, wrapped);
    const c = createSessionCache<string[]>({
      key: KEY,
      ttlMs: 60_000,
      validate: isStrArr,
      maxRawLength: 50,
    });
    expect(c.getFresh()).toBeNull(); // 超限 → cache miss
    expect(sessionStorage.getItem(KEY)).toBeNull(); // 清毒:坏缓存被 removeItem
  });

  it('默认 16MiB 上限:getItem 返超 16MiB → cache-miss + removeItem(清毒)', () => {
    // jsdom sessionStorage 有 5MB 配额无法 setItem 16MiB,故 mock getItem 返超大串绕过配额。
    const huge = 'z'.repeat(16 * 1024 * 1024 + 10); // 无需合法 JSON:cap 在 parse 前拦
    // jsdom Storage 方法在 prototype 上,spy 实例不拦截 → spy Storage.prototype。
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(huge);
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem');
    const c = createSessionCache<string[]>({ key: KEY, ttlMs: 60_000, validate: isStrArr });
    expect(c.getFresh()).toBeNull(); // 超默认上限 → cache miss
    expect(removeSpy).toHaveBeenCalledWith(KEY); // 清毒
    getSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('validate 失败的脏缓存会清毒,后续 stale 读取不重复 validate', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ fetchedAt: Date.now(), data: [1] }),
    );
    const validate = vi.fn(isStrArr);
    const c = createSessionCache<string[]>({
      key: KEY,
      ttlMs: 60_000,
      validate,
    });

    expect(c.getFresh()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(c.getStale()).toBeNull();
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
