// @vitest-environment jsdom
// S12 输入搜索词时 SearchAddon.findNext(同步扫描整段 scrollback)防抖:输入框状态立即更新,
// 停顿 TERMINAL_SEARCH_DEBOUNCE_MS 后只按最终词搜一次;Enter/上下跳转/选项切换/失焦立即 flush,
// 关闭/清空/卸载则取消挂起的搜索。
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
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { TERMINAL_SEARCH_DEBOUNCE_MS, useTerminal } from '../../panels/Terminal/useTerminal';

let api: ReturnType<typeof useTerminal>['searchApi'] | undefined;

function Host({ termId }: { termId: string }) {
  const { containerRef, searchApi } = useTerminal(termId);
  api = searchApi;
  return createElement('div', { ref: containerRef });
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


describe('S12 搜索词输入防抖', () => {
  it('连续输入只在停顿后按最终词 findNext 一次,输入框状态立即更新', () => {
    render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    const addon = hoisted.addon!;
    for (const t of ['e', 'er', 'err', 'erro', 'error']) {
      act(() => api!.setTerm(t));
      expect(api!.term).toBe(t);
    }
    expect(addon.findNext).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(TERMINAL_SEARCH_DEBOUNCE_MS);
    });
    expect(addon.findNext).toHaveBeenCalledTimes(1);
    expect(addon.findNext).toHaveBeenCalledWith('error', expect.anything());
    expect(api!.result).toEqual({ index: 0, count: 3 });
  });

  it('Enter(next)在防抖窗口内:先 flush 搜索再跳下一个,与未防抖时序一致', () => {
    render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    const addon = hoisted.addon!;
    act(() => api!.setTerm('warn'));
    act(() => api!.next());
    expect(addon.findNext.mock.calls.map((c) => c[0])).toEqual(['warn', 'warn']);
    expect(api!.result).toEqual({ index: 0, count: 3 });
    // flush 后定时器已清,不会再补一次搜索
    act(() => {
      vi.advanceTimersByTime(TERMINAL_SEARCH_DEBOUNCE_MS * 2);
    });
    expect(addon.findNext).toHaveBeenCalledTimes(2);
  });

  it('prev / 选项切换 / 失焦 都先 flush 挂起的搜索', () => {
    render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    const addon = hoisted.addon!;

    act(() => api!.setTerm('a'));
    act(() => api!.prev());
    expect(addon.findNext).toHaveBeenCalledWith('a', expect.anything());
    expect(addon.findPrevious).toHaveBeenCalledWith('a', expect.anything());

    addon.findNext.mockClear();
    act(() => api!.setTerm('ab'));
    act(() => api!.setOptions({ regex: false, caseSensitive: true, wholeWord: false }));
    expect(addon.findNext.mock.calls.map((c) => [c[0], c[1].caseSensitive])).toEqual([
      ['ab', false],
      ['ab', true],
    ]);

    addon.findNext.mockClear();
    act(() => api!.setTerm('abc'));
    act(() => api!.clearActiveDecoration());
    expect(addon.findNext).toHaveBeenCalledWith('abc', expect.anything());
    expect(addon.clearActiveDecoration).toHaveBeenCalled();
  });

  it('关闭 / 清空 / 卸载 取消挂起的搜索', () => {
    const { unmount } = render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    const addon = hoisted.addon!;

    act(() => api!.setTerm('x'));
    act(() => api!.close());
    act(() => {
      vi.advanceTimersByTime(TERMINAL_SEARCH_DEBOUNCE_MS);
    });
    expect(addon.findNext).not.toHaveBeenCalled();

    act(() => api!.open());
    act(() => api!.setTerm('x'));
    act(() => api!.setTerm(''));
    expect(addon.clearDecorations).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(TERMINAL_SEARCH_DEBOUNCE_MS);
    });
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(api!.result).toEqual({ index: -1, count: 0 });

    act(() => api!.setTerm('y'));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(addon.findNext).not.toHaveBeenCalled();
  });
});

// 缺陷 A(hook 侧):⌘F / 命令面板在搜索条已打开时再次 open,须发出新的聚焦请求(focusRequest 递增),
// 搜索条据此重新聚焦并全选输入框(VSCode 行为);不能因 isOpen 已为 true 而无事发生。
describe('S14 已打开时再次 open 发出聚焦请求', () => {
  it('每次 open 都递增 focusRequest(包括已打开时);其它动作不递增', () => {
    render(createElement(Host, { termId: 'term-a' }));
    act(() => api!.open());
    const first = api!.focusRequest;
    act(() => api!.setTerm('foo'));
    act(() => api!.next());
    expect(api!.focusRequest).toBe(first);
    act(() => api!.open());
    expect(api!.isOpen).toBe(true);
    expect(api!.focusRequest).toBe(first + 1);
  });

  it('SearchAddon 以显式 highlightLimit 构造(与计数显示的上限同一常量)', async () => {
    const { SearchAddon } = await import('@xterm/addon-search');
    const { TERMINAL_SEARCH_HIGHLIGHT_LIMIT } = await import(
      '../../panels/Terminal/terminal-search-state'
    );
    render(createElement(Host, { termId: 'term-a' }));
    expect(SearchAddon).toHaveBeenCalledWith({
      highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
    });
  });
});
