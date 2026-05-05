// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
  lmApi,
} from '../../lib/lm-api';
import { sandboxSweep } from '../../plugins/sandbox-sweep';

const originalApi = (window as { api?: unknown }).api;

beforeEach(() => {
  _resetLmApiForTest();
});

afterEach(() => {
  // 恢复测试间隔离
  if (originalApi !== undefined) {
    Object.defineProperty(window, 'api', {
      value: originalApi,
      writable: true,
      configurable: true,
    });
  } else {
    delete (window as { api?: unknown }).api;
  }
});

describe('lmApi Proxy fallback', () => {
  it('未 capture + window.api 有 → fallback 走 globalThis', () => {
    const fakeApi = { fs: { readFile: () => 'mocked' } };
    Object.defineProperty(window, 'api', {
      value: fakeApi,
      writable: true,
      configurable: true,
    });

    // 未 capture
    expect(lmApi.fs).toBe(fakeApi.fs);
  });

  it('未 capture + window.api 没 → 访问抛错', () => {
    delete (window as { api?: unknown }).api;
    delete (window as { __lmApi?: unknown }).__lmApi;
    expect(() => (lmApi as unknown as { fs: unknown }).fs).toThrow(
      /未注入/,
    );
  });
});

describe('captureLmApi + lmApi 缓存', () => {
  it('capture 后再访问走缓存,即使 window.api 改了也不变', () => {
    const original = { fs: { mark: 'original' } };
    Object.defineProperty(window, 'api', {
      value: original,
      writable: true,
      configurable: true,
    });
    captureLmApi();

    // 改 window.api 应不影响 lmApi(已缓存)
    Object.defineProperty(window, 'api', {
      value: { fs: { mark: 'new' } },
      writable: true,
      configurable: true,
    });

    expect((lmApi.fs as unknown as { mark: string }).mark).toBe('original');
  });

  it('capture 时 window.api/__lmApi 都缺 → 不抛,只 warn', () => {
    delete (window as { api?: unknown }).api;
    delete (window as { __lmApi?: unknown }).__lmApi;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => captureLmApi()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[lm-api] window.__lmApi/api 未注入'),
    );
    warn.mockRestore();
  });
});

describe('Phase 4.B refined:优先 __lmApi(PROD 名)', () => {
  it('window.__lmApi 存在 → fallback 优先取它,不取 window.api', () => {
    const lmApiObj = { fs: { tag: '__lmApi' } };
    Object.defineProperty(window, '__lmApi', {
      value: lmApiObj,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'api', {
      value: { fs: { tag: 'old-api' } },
      writable: true,
      configurable: true,
    });

    expect((lmApi.fs as unknown as { tag: string }).tag).toBe('__lmApi');

    delete (window as { __lmApi?: unknown }).__lmApi;
  });

  it('captureLmApi 优先吃 __lmApi(PROD 路径)', () => {
    Object.defineProperty(window, '__lmApi', {
      value: { fs: { tag: 'prod' } },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    expect((lmApi.fs as unknown as { tag: string }).tag).toBe('prod');

    delete (window as { __lmApi?: unknown }).__lmApi;
  });
});

describe('lmApi 与 sandboxSweep 协作', () => {
  it('capture → sweep → lmApi 仍能访问缓存(plugin 看不到 window.api)', () => {
    const fakeApi = { fs: { tag: 'cached' } };
    Object.defineProperty(window, 'api', {
      value: fakeApi,
      writable: true,
      configurable: true,
    });
    captureLmApi();

    sandboxSweep();

    // window.api 已被 sweep
    expect((window as { api?: unknown }).api).toBeUndefined();
    // 但 lmApi 仍走缓存
    expect((lmApi.fs as unknown as { tag: string }).tag).toBe('cached');
  });
});
