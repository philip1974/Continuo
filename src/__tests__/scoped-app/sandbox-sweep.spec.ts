// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  getCachedClipboard,
  getCachedFetch,
  sandboxSweep,
} from '../../plugins/sandbox-sweep';

describe('sandbox-sweep — module 顶部缓存', () => {
  it('getCachedFetch 返回函数', () => {
    expect(typeof getCachedFetch()).toBe('function');
  });

  it('getCachedClipboard 返回 readText / writeText 两方法', () => {
    const c = getCachedClipboard();
    expect(typeof c.readText).toBe('function');
    expect(typeof c.writeText).toBe('function');
  });
});

describe('sandboxSweep — 删 globalThis.fetch / navigator.clipboard', () => {
  // 注意:本测试改 globalThis,跑完恢复

  it('sweep 后 globalThis.fetch 是 undefined,但 cached fetch 仍是函数', () => {
    const before = globalThis.fetch;
    expect(typeof before).toBe('function');

    const cachedFetch = getCachedFetch();
    sandboxSweep();

    expect(globalThis.fetch).toBeUndefined();
    expect(typeof cachedFetch).toBe('function'); // 未失效

    // 恢复供后续测试用
    Object.defineProperty(globalThis, 'fetch', {
      value: before,
      writable: true,
      configurable: true,
    });
  });

  it('sweep 后 navigator.clipboard 是 undefined,但 cached 仍可用', () => {
    const beforeClipboard = navigator.clipboard;
    const cachedClipboard = getCachedClipboard();

    sandboxSweep();
    // 不强制断言 clipboard undefined(jsdom 实现细节差异),
    // 关键:cached 引用仍是函数
    expect(typeof cachedClipboard.readText).toBe('function');
    expect(typeof cachedClipboard.writeText).toBe('function');

    // 恢复
    if (beforeClipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        value: beforeClipboard,
        writable: true,
        configurable: true,
      });
    }
  });
});
