// @vitest-environment jsdom
// 侧栏拖宽:每个 mousemove 写 layoutUi.sidebarWidth。终端不得因此逐像素 React 重渲染
// (最多 64 个终端 × 每像素),拖动期间的 fit 交给容器 ResizeObserver;sidebarWidth 只作 RO 漏报兜底:
// 停下 SIDEBAR_WIDTH_FIT_SETTLE_MS 后必定补一次 fit。sidebarOpen 显隐仍下一帧 fit(issue #15)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({ fit: vi.fn(), rafs: [] as Array<() => void> }));

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
      buffer: { normal: { length: 0 } },
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: hoisted.fit })) }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  })),
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

import { SIDEBAR_WIDTH_FIT_SETTLE_MS, useTerminal } from '../../panels/Terminal/useTerminal';
import { SIDEBAR_DEFAULT_WIDTH, useLayoutUiStore } from '../../stores/layout-ui.store';

let renders = 0;
function Host({ termId }: { termId: string }) {
  renders++;
  const { containerRef } = useTerminal(termId);
  return createElement('div', { ref: containerRef });
}

function flushRafs() {
  const queued = hoisted.rafs.splice(0);
  for (const cb of queued) cb();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  renders = 0;
  hoisted.rafs.length = 0;
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: SIDEBAR_DEFAULT_WIDTH });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: () => void) => hoisted.rafs.push(cb),
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

describe('侧栏拖宽 → 终端 fit', () => {
  it('拖动中每像素宽度变化不重渲染终端;停下后补一次 fit', () => {
    render(createElement(Host, { termId: 'term-a' }));
    flushRafs();
    hoisted.fit.mockClear();
    const rendersBefore = renders;

    for (let w = 281; w <= 340; w++) {
      act(() => useLayoutUiStore.getState().setSidebarWidth(w));
      flushRafs();
    }
    expect(renders).toBe(rendersBefore);
    expect(hoisted.fit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SIDEBAR_WIDTH_FIT_SETTLE_MS);
    });
    expect(hoisted.fit).toHaveBeenCalledTimes(1);
  });

  it('sidebarOpen 切换仍在下一帧补 fit', () => {
    render(createElement(Host, { termId: 'term-a' }));
    flushRafs();
    hoisted.fit.mockClear();
    act(() => useLayoutUiStore.getState().setSidebarOpen(false));
    expect(hoisted.fit).not.toHaveBeenCalled();
    flushRafs();
    expect(hoisted.fit).toHaveBeenCalledTimes(1);
  });

  it('卸载后不再补 fit', () => {
    const { unmount } = render(createElement(Host, { termId: 'term-a' }));
    flushRafs();
    act(() => useLayoutUiStore.getState().setSidebarWidth(300));
    unmount();
    hoisted.fit.mockClear();
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_WIDTH_FIT_SETTLE_MS);
    });
    expect(hoisted.fit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
