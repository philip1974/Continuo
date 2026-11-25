// @vitest-environment jsdom
// BDD: terminal-vscode-parity / 5 终端链接需修饰键单击才打开(VSCode:mac ⌘+单击,其它 Ctrl+单击),悬停提示
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

type LinkHandler = (event: MouseEvent, url: string) => void;
interface LinkOptions {
  hover?: (event: MouseEvent, text: string) => void;
  leave?: (event: MouseEvent, text: string) => void;
}

const mock = vi.hoisted(() => ({
  linkHandler: undefined as LinkHandler | undefined,
  linkOptions: undefined as LinkOptions | undefined,
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
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn((handler: LinkHandler, options: LinkOptions) => {
    mock.linkHandler = handler;
    mock.linkOptions = options;
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
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: mock.openExternal },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { isTerminalLinkActivation, terminalLinkHoverHint, useTerminal } from '../../panels/Terminal/useTerminal';
import { setLocale } from '../../i18n';

function Host() {
  const { containerRef } = useTerminal('term-link');
  return createElement('div', { ref: containerRef, 'data-testid': 'host' });
}

beforeEach(() => {
  setLocale('zh');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setLocale('en');
});

describe('修饰键判定', () => {
  it('mac 认 ⌘,其它认 Ctrl;无修饰键不打开', () => {
    expect(isTerminalLinkActivation(new MouseEvent('click', { metaKey: true }), 'mac')).toBe(true);
    expect(isTerminalLinkActivation(new MouseEvent('click', { ctrlKey: true }), 'mac')).toBe(false);
    expect(isTerminalLinkActivation(new MouseEvent('click', { ctrlKey: true }), 'other')).toBe(true);
    expect(isTerminalLinkActivation(new MouseEvent('click', { metaKey: true }), 'other')).toBe(false);
    expect(isTerminalLinkActivation(new MouseEvent('click'), 'mac')).toBe(false);
  });
  it('悬停提示按平台本地化', () => {
    expect(terminalLinkHoverHint('mac')).toBe('⌘+单击打开链接');
    expect(terminalLinkHoverHint('other')).toBe('Ctrl+单击打开链接');
  });
});

describe('useTerminal 接线', () => {
  it('单击不打开;修饰键单击才打开', () => {
    render(createElement(Host));
    mock.linkHandler!(new MouseEvent('click'), 'https://example.com');
    expect(mock.openExternal).not.toHaveBeenCalled();
    mock.linkHandler!(new MouseEvent('click', { metaKey: true, ctrlKey: true }), 'https://example.com');
    expect(mock.openExternal).toHaveBeenCalledWith('https://example.com');
  });
  it('悬停链接时容器带提示,离开后移除', () => {
    const { getByTestId } = render(createElement(Host));
    const host = getByTestId('host');
    mock.linkOptions!.hover!(new MouseEvent('mousemove'), 'https://example.com');
    expect(host.title).toMatch(/\+单击打开链接$/);
    mock.linkOptions!.leave!(new MouseEvent('mouseleave'), 'https://example.com');
    expect(host.hasAttribute('title')).toBe(false);
  });
});
