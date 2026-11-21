// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
  coApi,
} from '../../lib/co-api';
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

describe('coApi Proxy fallback', () => {
  it('未 capture + window.api 有 → fallback 走 globalThis', () => {
    const fakeApi = { fs: { readFile: () => 'mocked' } };
    Object.defineProperty(window, 'api', {
      value: fakeApi,
      writable: true,
      configurable: true,
    });

    // 未 capture
    expect(coApi.fs).toBe(fakeApi.fs);
  });

  it('未 capture + window.api 没 → 访问抛错', () => {
    delete (window as { api?: unknown }).api;
    delete (window as { __lmApi?: unknown }).__lmApi;
    expect(() => (coApi as unknown as { fs: unknown }).fs).toThrow(
      /未注入/,
    );
  });
});

describe('captureLmApi + coApi 缓存', () => {
  it('capture 后再访问走缓存,即使 window.api 改了也不变', () => {
    const original = { fs: { mark: 'original' } };
    Object.defineProperty(window, 'api', {
      value: original,
      writable: true,
      configurable: true,
    });
    captureLmApi();

    // 改 window.api 应不影响 coApi(已缓存)
    Object.defineProperty(window, 'api', {
      value: { fs: { mark: 'new' } },
      writable: true,
      configurable: true,
    });

    expect((coApi.fs as unknown as { mark: string }).mark).toBe('original');
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
  it('window.__lmApi claimRendererApi 存在 → fallback 优先领取它,不取 window.api', () => {
    const lmApiObj = { fs: { tag: '__lmApi' } };
    const bridge = {
      claimRendererApi: vi.fn(() => lmApiObj),
    };
    Object.defineProperty(window, '__lmApi', {
      value: bridge,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, 'api', {
      value: { fs: { tag: 'old-api' } },
      writable: true,
      configurable: true,
    });

    expect((coApi.fs as unknown as { tag: string }).tag).toBe('__lmApi');
    expect(bridge.claimRendererApi).toHaveBeenCalledOnce();

    delete (window as { __lmApi?: unknown }).__lmApi;
  });

  it('captureLmApi 优先领取 __lmApi claimRendererApi(PROD 路径)', () => {
    const bridge = {
      claimRendererApi: vi.fn(() => ({ fs: { tag: 'prod' } })),
    };
    Object.defineProperty(window, '__lmApi', {
      value: bridge,
      writable: true,
      configurable: true,
    });
    captureLmApi();
    expect((coApi.fs as unknown as { tag: string }).tag).toBe('prod');
    expect(bridge.claimRendererApi).toHaveBeenCalledOnce();

    delete (window as { __lmApi?: unknown }).__lmApi;
  });

  it('claimRendererApi 一次性领取后,插件阶段再次 claim 得不到 API', () => {
    const api = { fs: { tag: 'claimed' } };
    let claimed = false;
    const bridge = {
      claimRendererApi: vi.fn(() => {
        if (claimed) return null;
        claimed = true;
        return api;
      }),
    };
    Object.defineProperty(window, '__lmApi', {
      value: bridge,
      writable: true,
      configurable: true,
    });

    captureLmApi();

    expect((coApi.fs as unknown as { tag: string }).tag).toBe('claimed');
    expect(bridge.claimRendererApi()).toBeNull();
    expect(
      ((window as { __lmApi?: unknown }).__lmApi as { fs?: unknown }).fs,
    ).toBeUndefined();

    delete (window as { __lmApi?: unknown }).__lmApi;
  });
});

describe('coApi 与 sandboxSweep 协作', () => {
  it('capture → sweep → coApi 仍能访问缓存(plugin 看不到 window.api)', () => {
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
    // 但 coApi 仍走缓存
    expect((coApi.fs as unknown as { tag: string }).tag).toBe('cached');
  });
});
