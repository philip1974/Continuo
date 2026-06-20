// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

type LinkHandler = (event: MouseEvent, url: string) => void;

const mock = vi.hoisted(() => ({
  linkHandler: undefined as LinkHandler | undefined,
  openExternal: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>, options: Record<string, unknown>) {
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
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn((handler: LinkHandler) => {
    mock.linkHandler = handler;
    return { dispose: vi.fn() };
  }),
}));
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
    shell: {
      openExternal: mock.openExternal,
    },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_key: string, fallback: T) => fallback }));
vi.mock('@/stores/layout-ui.store', () => ({
  useLayoutUiStore: (selector: (state: { sidebarOpen: boolean; sidebarWidth: number }) => unknown) => selector({ sidebarOpen: true, sidebarWidth: 280 }),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
import { useTerminal } from '../../panels/Terminal/useTerminal';
function Host() {
  const { containerRef } = useTerminal('term-url');
  return createElement('div', { ref: containerRef });
}
function mountAndGetHandler(): LinkHandler {
  render(createElement(Host));
  expect(mock.linkHandler).toEqual(expect.any(Function));
  return mock.linkHandler!;
}
beforeEach(() => {
  mock.linkHandler = undefined;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('terminal-url-click', () => {
  it('点击 URL 通过 coApi.shell.openExternal 打开', () => {
    const url = 'https://example.com/path?q=1';
    mountAndGetHandler()(new MouseEvent('click'), url);
    expect(mock.openExternal).toHaveBeenCalledTimes(1);
    expect(mock.openExternal).toHaveBeenCalledWith(url);
  });
});
