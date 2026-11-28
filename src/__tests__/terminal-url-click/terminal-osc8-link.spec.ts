// @vitest-environment jsdom
// BDD: terminal-url-click / OSC 8 超链接(程序输出的 `ESC]8;;<uri>ST 文字 ESC]8;;ST`)走 xterm 的 linkHandler:
// 与普通 URL 同一规则 —— ⌘ / Ctrl+单击才打开、走同一外链出口;悬停显示真实地址。不设 linkHandler 时 xterm 普通单击
// 弹英文原生 confirm、确定后也打不开(VSCode terminalLinkManager 设了 linkHandler)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

type LinkHandler = (event: MouseEvent, url: string) => void;

const mock = vi.hoisted(() => ({
  linkHandler: undefined as LinkHandler | undefined,
  options: undefined as Record<string, unknown> | undefined,
  openExternal: vi.fn().mockResolvedValue({ ok: true }),
  notifyError: vi.fn(),
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: mock.notifyError } }));
vi.mock('@/lib/localize-error', () => ({
  localizeErrorByCode: (code: string | undefined, msg?: string) => msg ?? code ?? '',
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>, options: Record<string, unknown>) {
    mock.options = options;
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
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: {
      openExternal: mock.openExternal,
    },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_key: string, fallback: T) => fallback }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
import { terminalLinkHoverHint, terminalOscLinkHoverHint, useTerminal } from '../../panels/Terminal/useTerminal';

interface OscLinkHandler {
  allowNonHttpProtocols?: boolean;
  activate(event: MouseEvent, uri: string): void;
  hover?(event: MouseEvent, uri: string): void;
  leave?(event: MouseEvent, uri: string): void;
}

function Host() {
  const { containerRef } = useTerminal('term-osc8');
  return createElement('div', { ref: containerRef, 'data-testid': 'host' });
}
function mount(): { handler: OscLinkHandler; container: HTMLElement } {
  const r = render(createElement(Host));
  const handler = mock.options?.linkHandler as OscLinkHandler | undefined;
  expect(handler).toBeDefined();
  return { handler: handler!, container: r.getByTestId('host') };
}
beforeEach(() => {
  mock.options = undefined;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('终端 OSC 8 超链接', () => {
  it('普通单击不打开(也不弹原生 confirm:linkHandler 已设);⌘ / Ctrl+单击经 coApi.shell.openExternal 打开', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { handler } = mount();
    handler.activate(new MouseEvent('click'), 'https://example.com/osc');
    expect(mock.openExternal).not.toHaveBeenCalled();
    handler.activate(new MouseEvent('click', { metaKey: true, ctrlKey: true }), 'https://example.com/osc');
    expect(mock.openExternal).toHaveBeenCalledWith('https://example.com/osc');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('非 http(s) 也交给外链出口判定(不允许的由出口拒绝并提示),不被 xterm 静默吞掉', async () => {
    mock.openExternal.mockResolvedValueOnce({ ok: false, code: 'CO_COMMAND_BLOCKED' });
    const { handler } = mount();
    expect(handler.allowNonHttpProtocols).toBe(true);
    handler.activate(new MouseEvent('click', { metaKey: true, ctrlKey: true }), 'file:///etc/passwd');
    expect(mock.openExternal).toHaveBeenCalledWith('file:///etc/passwd');
    await vi.waitFor(() => expect(mock.notifyError).toHaveBeenCalledTimes(1));
  });

  it('悬停显示真实地址 + 「⌘+单击打开链接」,离开清除;地址里的双向控制字符可见化', () => {
    const { handler, container } = mount();
    handler.hover!(new MouseEvent('mouseover'), 'https://evil.test/\u202Egnp.exe');
    expect(container.title).toBe(terminalOscLinkHoverHint('https://evil.test/\u202Egnp.exe'));
    expect(container.title.split('\n')).toEqual(['https://evil.test/\uFFFDgnp.exe', terminalLinkHoverHint()]);
    handler.leave!(new MouseEvent('mouseout'), 'https://evil.test/');
    expect(container.hasAttribute('title')).toBe(false);
  });
});
