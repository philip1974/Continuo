// @vitest-environment jsdom
// BDD:终端延迟初始化使用最新的设置与主题。见同目录 README。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  terminalOptions: [] as Array<Record<string, unknown>>,
  fontSize: 13,
  resolved: 'dark' as 'dark' | 'light',
  size: 0,
  resizeCallbacks: [] as Array<() => void>,
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
    h.terminalOptions.push({ ...options });
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options,
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    findNext: vi.fn(() => false),
    findPrevious: vi.fn(() => false),
    clearDecorations: vi.fn(),
    clearActiveDecoration: vi.fn(),
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
      onExit: vi.fn(() => vi.fn()),
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(key: string, fallback: T) =>
    key === 'terminal.fontSize' ? (h.fontSize as unknown as T) : fallback,
}));
vi.mock('@/stores/layout-ui.store', () => ({
  useLayoutUiStore: (
    s: (state: { sidebarOpen: boolean; sidebarWidth: number }) => unknown,
  ) => s({ sidebarOpen: true, sidebarWidth: 280 }),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: h.resolved }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';

function Host({ tick }: { tick: number }) {
  const { containerRef } = useTerminal('term-1');
  return createElement('div', { ref: containerRef, 'data-tick': tick });
}

beforeEach(() => {
  h.terminalOptions.length = 0;
  h.resizeCallbacks.length = 0;
  h.fontSize = 13;
  h.resolved = 'dark';
  h.size = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => h.size });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => h.size });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(cb: () => void) {
        h.resizeCallbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    },
  });
});

afterEach(() => cleanup());

function backgroundOf(options: Record<string, unknown>): unknown {
  return (options.theme as { background?: unknown } | undefined)?.background;
}

describe('终端延迟初始化', () => {
  it('0 尺寸挂载 → 不创建 xterm;获得尺寸后创建', () => {
    render(createElement(Host, { tick: 0 }));
    expect(h.terminalOptions).toHaveLength(0);

    h.size = 400;
    act(() => h.resizeCallbacks.forEach((cb) => cb()));
    expect(h.terminalOptions).toHaveLength(1);
  });

  it('等待期间改了字号与主题 → 创建时用变化后的值', () => {
    // 先在有尺寸时各建一个,取 dark / light 主题各自的背景色作对照。
    h.size = 400;
    render(createElement(Host, { tick: 0 }));
    const darkBackground = backgroundOf(h.terminalOptions[0]!);
    cleanup();
    h.resolved = 'light';
    render(createElement(Host, { tick: 0 }));
    const lightBackground = backgroundOf(h.terminalOptions[1]!);
    cleanup();
    expect(lightBackground).not.toBe(darkBackground);

    // 正题:dark + 13 号、0 尺寸挂载。
    h.terminalOptions.length = 0;
    h.resizeCallbacks.length = 0;
    h.resolved = 'dark';
    h.fontSize = 13;
    h.size = 0;
    const view = render(createElement(Host, { tick: 0 }));
    expect(h.terminalOptions).toHaveLength(0);

    // 面板不可见期间用户切到 light、字号改 18。
    h.resolved = 'light';
    h.fontSize = 18;
    view.rerender(createElement(Host, { tick: 1 }));

    h.size = 400;
    act(() => h.resizeCallbacks.forEach((cb) => cb()));
    expect(h.terminalOptions).toHaveLength(1);
    expect(h.terminalOptions[0]!.fontSize).toBe(18);
    expect(backgroundOf(h.terminalOptions[0]!)).toBe(lightBackground);
  });
});
