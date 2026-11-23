// @vitest-environment jsdom
// S11 正则模式下输入非法正则(`[` / `(` / `\`):xterm SearchAddon 内部直接 RegExp(term) 抛
// SyntaxError,且无 try/catch → 异常穿透 dispatchSearchAction 冒出事件处理器。期望:
// 本仓调用侧预校验,非法正则表现为「无匹配」(计数归零、清高亮、不调 addon),搜索框保持
// 可用,改回合法正则后照常搜索。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  resultsHandler: undefined as
    | ((e: { resultIndex: number; resultCount: number }) => void)
    | undefined,
  addon: undefined as
    | {
        findNext: ReturnType<typeof vi.fn>;
        findPrevious: ReturnType<typeof vi.fn>;
        clearDecorations: ReturnType<typeof vi.fn>;
      }
    | undefined,
  clearSelection: vi.fn(),
}));

vi.mock('@continuo-terminal/react-terminal', async (importActual) => {
  const actual = await importActual<typeof import('@continuo-terminal/react-terminal')>();
  return { ...actual, registerOsc7Cwd: vi.fn(() => ({ dispose: vi.fn() })) };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(
    this: Record<string, unknown>,
    options: Record<string, unknown>,
  ) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options,
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      clearSelection: hoisted.clearSelection,
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
// 搜索 addon 桩:模拟真实 SearchEngine —— regex 模式直接 RegExp(term)(非法即抛 SyntaxError),
// 合法时同步 fire onDidChangeResults。
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => {
    const find = vi.fn((term: string, opts?: { regex?: boolean }) => {
      if (opts?.regex) RegExp(term, 'g');
      hoisted.resultsHandler?.({ resultIndex: 0, resultCount: 3 });
      return true;
    });
    const addon = {
      findNext: find,
      findPrevious: vi.fn(find),
      clearDecorations: vi.fn(),
      clearActiveDecoration: vi.fn(),
      onDidChangeResults: vi.fn((h: (e: { resultIndex: number; resultCount: number }) => void) => {
        hoisted.resultsHandler = h;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(),
    };
    hoisted.addon = addon;
    return addon;
  }),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    terminal: {
      resize: vi.fn().mockResolvedValue({ ok: true }),
      updateCwd: vi.fn().mockResolvedValue({ ok: true }),
      onData: vi.fn(() => vi.fn()),
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_k: string, fb: T) => fb,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { TERMINAL_SEARCH_DEBOUNCE_MS, useTerminal } from '../../panels/Terminal/useTerminal';

let api: ReturnType<typeof useTerminal>['searchApi'] | undefined;

function Host({ termId }: { termId: string }) {
  const { containerRef, searchApi } = useTerminal(termId);
  api = searchApi;
  return createElement('div', { ref: containerRef });
}

const REGEX = { regex: true, caseSensitive: false, wholeWord: false };

// 输入搜索词的 findNext 有防抖(S12):输入后推进防抖窗口,等价于用户停顿。
function typeTerm(term: string) {
  act(() => api!.setTerm(term));
  act(() => {
    vi.advanceTimersByTime(TERMINAL_SEARCH_DEBOUNCE_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  hoisted.resultsHandler = undefined;
  hoisted.addon = undefined;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('S11 正则模式非法正则 → 无匹配,搜索框继续可用', () => {
  it('setTerm / setOptions / next / prev 遇非法正则都不抛,计数归零并清高亮', async () => {
    render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    typeTerm('foo');
    expect(api!.result).toEqual({ index: 0, count: 3 });

    act(() => api!.setOptions(REGEX));
    const addon = hoisted.addon!;
    addon.findNext.mockClear();
    addon.findPrevious.mockClear();
    addon.clearDecorations.mockClear();
    hoisted.clearSelection.mockClear();

    for (const bad of ['[', '(', '\\']) {
      expect(() => typeTerm(bad)).not.toThrow();
      expect(api!.result).toEqual({ index: -1, count: 0 });
      expect(api!.isOpen).toBe(true);
      expect(api!.term).toBe(bad);
      expect(() => act(() => api!.next())).not.toThrow();
      expect(() => act(() => api!.prev())).not.toThrow();
      expect(api!.result).toEqual({ index: -1, count: 0 });
    }
    // 非法正则不进 addon(否则其防抖重搜在 setTimeout 里再抛),改为清高亮
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(addon.findPrevious).not.toHaveBeenCalled();
    expect(addon.clearDecorations).toHaveBeenCalled();
    // 之前合法搜索 findNext 选中的匹配(xterm selection)也要清,否则仍高亮选中
    expect(hoisted.clearSelection).toHaveBeenCalled();

    // 改回合法正则 → 照常搜索
    typeTerm('fo+');
    expect(addon.findNext).toHaveBeenCalledWith('fo+', expect.objectContaining({ regex: true }));
    expect(api!.result).toEqual({ index: 0, count: 3 });
  });

  it('非 regex 模式下含 `[` 的字面量照常搜索', async () => {
    render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    typeTerm('[');
    expect(hoisted.addon!.findNext).toHaveBeenCalledWith('[', expect.objectContaining({ regex: false }));
    expect(api!.result).toEqual({ index: 0, count: 3 });
  });

  it('已有非法正则字面量时打开 regex 开关 → 无匹配,不抛', async () => {
    render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    typeTerm('(');
    expect(() => act(() => api!.setOptions(REGEX))).not.toThrow();
    expect(api!.result).toEqual({ index: -1, count: 0 });
    expect(api!.options.regex).toBe(true);
  });
});
