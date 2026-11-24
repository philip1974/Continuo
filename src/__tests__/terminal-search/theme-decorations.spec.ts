// @vitest-environment jsdom
// S13 搜索装饰色取自主题 token(light / dark 各有值),主题切换后下一次搜索按新主题取色。
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
        clearActiveDecoration: ReturnType<typeof vi.fn>;
      }
    | undefined,
  clearSelection: vi.fn(),
  resolved: 'dark' as 'dark' | 'light',
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
      focus: vi.fn(),
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
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: hoisted.resolved }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import {
  FALLBACK_TERMINAL_SEARCH_DECORATIONS,
  getTerminalSearchDecorations,
  invalidateTerminalSearchDecorations,
} from '../../panels/Terminal/terminal-search-state';
import { readThemeTokens } from '../../theme/read-theme-tokens';

const DARK = {
  '--md-primary-container': '#2563eb',
  '--md-primary': '#b4c5ff',
  '--md-on-primary-container': '#eeefff',
};
const LIGHT = {
  '--md-primary-container': '#eaddff',
  '--md-primary': '#6750a4',
  '--md-on-primary-container': '#21005d',
};

function setTokens(tokens: Record<string, string>): void {
  for (const [name, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(name, value);
  }
}

function clearTokens(): void {
  document.documentElement.removeAttribute('style');
}

let api: ReturnType<typeof useTerminal>['searchApi'] | undefined;

function Host({ termId }: { termId: string }) {
  const { containerRef, searchApi } = useTerminal(termId);
  api = searchApi;
  return createElement('div', { ref: containerRef });
}

beforeEach(() => {
  hoisted.resultsHandler = undefined;
  hoisted.addon = undefined;
  hoisted.resolved = 'dark';
  clearTokens();
  invalidateTerminalSearchDecorations();
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
  clearTokens();
  vi.clearAllMocks();
});

describe('readThemeTokens', () => {
  it('按 {键: CSS 变量} 读 <html> 上的计算值(去首尾空白)', () => {
    setTokens({ '--md-primary': ' #b4c5ff ', '--md-primary-container': '#2563eb' });
    expect(
      readThemeTokens({ accent: '--md-primary', fill: '--md-primary-container' }),
    ).toEqual({ accent: '#b4c5ff', fill: '#2563eb' });
  });

  it('任一 token 读不到 → null(调用方整体走兜底,不拼残缺配色)', () => {
    setTokens({ '--md-primary': '#b4c5ff' });
    expect(
      readThemeTokens({ accent: '--md-primary', fill: '--md-primary-container' }),
    ).toBeNull();
  });
});

describe('S13 终端搜索装饰色取自主题 token', () => {
  it('token 就绪 → 装饰色即当前主题 token 值', () => {
    setTokens(LIGHT);
    expect(getTerminalSearchDecorations()).toEqual({
      matchBackground: '#eaddff',
      matchBorder: '#6750a4',
      matchOverviewRuler: '#6750a4',
      activeMatchBackground: '#6750a4',
      activeMatchBorder: '#21005d',
      activeMatchColorOverviewRuler: '#21005d',
    });
  });

  it('token 读不到或不是 #RRGGBB(xterm 只认该格式)→ 兜底色,且不缓存兜底', () => {
    expect(getTerminalSearchDecorations()).toBe(FALLBACK_TERMINAL_SEARCH_DECORATIONS);
    setTokens({ ...DARK, '--md-primary': 'rgba(1, 2, 3, 0.5)' });
    expect(getTerminalSearchDecorations()).toBe(FALLBACK_TERMINAL_SEARCH_DECORATIONS);
    setTokens(DARK);
    expect(getTerminalSearchDecorations().matchBackground).toBe('#2563eb');
  });

  it('取色结果缓存,作废后重新读 token', () => {
    setTokens(DARK);
    expect(getTerminalSearchDecorations().matchBackground).toBe('#2563eb');
    setTokens(LIGHT);
    expect(getTerminalSearchDecorations().matchBackground).toBe('#2563eb');
    invalidateTerminalSearchDecorations();
    expect(getTerminalSearchDecorations().matchBackground).toBe('#eaddff');
  });

  it('主题切换 → 清掉旧高亮,下一次搜索按新主题 token 取色;首次挂载不清', () => {
    setTokens(DARK);
    const { rerender } = render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    const addon = hoisted.addon!;
    act(() => api!.setOptions({ regex: false, caseSensitive: false, wholeWord: false }));
    act(() => api!.setTerm('x'));
    act(() => api!.next());
    expect(addon.findNext).toHaveBeenLastCalledWith(
      'x',
      expect.objectContaining({
        decorations: expect.objectContaining({ matchBackground: '#2563eb' }),
      }),
    );
    expect(addon.clearDecorations).not.toHaveBeenCalled();

    // ThemeProvider 切 <html class> / token 与 resolved 变化同一轮生效
    setTokens(LIGHT);
    hoisted.resolved = 'light';
    rerender(createElement(Host, { termId: 'term-a' }));
    expect(addon.clearDecorations).toHaveBeenCalledTimes(1);

    act(() => api!.next());
    expect(addon.findNext).toHaveBeenLastCalledWith(
      'x',
      expect.objectContaining({
        decorations: expect.objectContaining({
          matchBackground: '#eaddff',
          activeMatchBorder: '#21005d',
        }),
      }),
    );
  });
});

describe('S13 主题切换时无终端挂载 / 搜索条开着', () => {
  afterEach(() => document.documentElement.classList.remove('dark'));

  it('缓存按 <html>.dark 做键:未调 invalidate、主题已切 → 下一次取色按新主题', () => {
    document.documentElement.classList.add('dark');
    setTokens(DARK);
    expect(getTerminalSearchDecorations().matchBackground).toBe('#2563eb');
    // 关掉所有终端后切主题:无人调 invalidateTerminalSearchDecorations
    document.documentElement.classList.remove('dark');
    setTokens(LIGHT);
    expect(getTerminalSearchDecorations().matchBackground).toBe('#eaddff');
  });

  it('搜索条开着且有词 → 主题切换后下一帧按当前词重搜(新色重画,计数同步)', async () => {
    let rafCb: (() => void) | null = null;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (cb: () => void) => {
        rafCb = cb;
        return 1;
      },
    });
    vi.useFakeTimers();
    setTokens(DARK);
    const { rerender } = render(createElement(Host, { termId: 'term-b' }));
    act(() => api!.open());
    const addon = hoisted.addon!;
    act(() => api!.setTerm('x'));
    act(() => vi.runOnlyPendingTimers());
    const before = addon.findNext.mock.calls.length;

    setTokens(LIGHT);
    hoisted.resolved = 'light';
    rerender(createElement(Host, { termId: 'term-b' }));
    expect(addon.clearDecorations).toHaveBeenCalled();
    act(() => rafCb?.());
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    expect(addon.findNext.mock.calls.length).toBeGreaterThan(before);
    expect(addon.findNext).toHaveBeenLastCalledWith(
      'x',
      expect.objectContaining({
        decorations: expect.objectContaining({ matchBackground: '#eaddff' }),
      }),
    );
  });
});
