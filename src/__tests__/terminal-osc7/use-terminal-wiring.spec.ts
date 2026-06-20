// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  registerMock: vi.fn(),
  capturedOnCwd: undefined as ((cwd: string) => void) | undefined,
  disposeMock: vi.fn(),
}));

vi.mock('@continuo-terminal/react-terminal', async (importActual) => {
  const actual = await importActual<typeof import('@continuo-terminal/react-terminal')>();
  hoisted.registerMock.mockImplementation((_term, onCwd, _opts) => {
    hoisted.capturedOnCwd = onCwd;
    return { dispose: hoisted.disposeMock };
  });
  return { ...actual, registerOsc7Cwd: hoisted.registerMock };
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
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })) }));
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
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/stores/layout-ui.store', () => ({
  useLayoutUiStore: (s: (state: { sidebarOpen: boolean; sidebarWidth: number }) => unknown) =>
    s({ sidebarOpen: true, sidebarWidth: 280 }),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { coApi } from '@/lib/co-api';

function Host({ termId }: { termId: string }) {
  const { containerRef } = useTerminal(termId);
  return createElement('div', { ref: containerRef });
}

beforeEach(() => {
  hoisted.capturedOnCwd = undefined;
  hoisted.registerMock.mockClear();
  hoisted.disposeMock.mockClear();
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
  vi.clearAllMocks();
});

describe('terminal-osc7 wiring (T13)', () => {
  it('T13a: useTerminal calls registerOsc7Cwd once with structural term shape', () => {
    render(createElement(Host, { termId: 'term-osc7' }));

    expect(hoisted.registerMock).toHaveBeenCalledTimes(1);
    const firstCall = hoisted.registerMock.mock.calls[0]!;
    expect(firstCall[0]).toMatchObject({
      parser: expect.objectContaining({ registerOscHandler: expect.any(Function) }),
    });
    expect(firstCall[2]).toBeUndefined();
  });

  it('T13b: captured onCwd routes to coApi.terminal.updateCwd with termId', () => {
    render(createElement(Host, { termId: 'term-osc7' }));

    expect(hoisted.capturedOnCwd).toBeDefined();
    hoisted.capturedOnCwd!('/tmp');
    expect(coApi.terminal.updateCwd).toHaveBeenCalledTimes(1);
    expect(coApi.terminal.updateCwd).toHaveBeenCalledWith('term-osc7', '/tmp');
  });

  it('T13c: unmount triggers disposable.dispose once', () => {
    const { unmount } = render(createElement(Host, { termId: 'term-osc7' }));

    unmount();

    expect(hoisted.disposeMock).toHaveBeenCalledTimes(1);
  });
});
