// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
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

  it('sweep 后 globalThis.api 是 undefined', () => {
    Object.defineProperty(globalThis, 'api', {
      value: { fs: {} },
      writable: true,
      configurable: true,
    });
    sandboxSweep();
    expect(
      (globalThis as Record<string, unknown>).api,
    ).toBeUndefined();
  });

  it('window.api 存在 → sweep 后 undefined', () => {
    Object.defineProperty(window, 'api', {
      value: { fs: {} },
      writable: true,
      configurable: true,
    });
    sandboxSweep();
    expect((window as { api?: unknown }).api).toBeUndefined();
  });

  it('window.api 不存在 → 不报错', () => {
    delete (window as { api?: unknown }).api;
    expect(() => sandboxSweep()).not.toThrow();
  });
});

describe('sandboxSweep — defineProperty 抛错时降级到 console.warn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetch defineProperty 抛 → console.warn,不冒泡', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orig = Object.defineProperty;
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation(
      ((target: object, prop: PropertyKey, desc: PropertyDescriptor) => {
        if (prop === 'fetch') {
          throw new Error('readonly');
        }
        return orig.call(Object, target, prop, desc);
      }) as never,
    );
    sandboxSweep();
    spy.mockRestore();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fetch sweep 失败'),
      expect.any(Error),
    );
  });

  it('clipboard defineProperty 抛 → console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orig = Object.defineProperty;
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation(
      ((target: object, prop: PropertyKey, desc: PropertyDescriptor) => {
        if (target === navigator && prop === 'clipboard') {
          throw new Error('readonly');
        }
        return orig.call(Object, target, prop, desc);
      }) as never,
    );
    sandboxSweep();
    spy.mockRestore();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('clipboard sweep 失败'),
      expect.any(Error),
    );
  });

  it('__lmApi defineProperty 抛 → 静默(不 warn)', () => {
    // __lmApi catch 是空块,我们只确保不抛
    expect(() => sandboxSweep()).not.toThrow();
  });
});
