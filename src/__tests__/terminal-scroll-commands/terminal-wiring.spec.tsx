// @vitest-environment jsdom
// BDD: terminal-scroll-commands / 1-3 useTerminal 接线:滚动键滚动视口不发字节;备用屏交给程序;mac 未绑定 ⌘ 组合不交给 xterm
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, useEffect } from 'react';

const h = vi.hoisted(() => ({
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
  bufferChange: undefined as (() => void) | undefined,
  buffer: { type: 'normal' as 'normal' | 'alternate' },
  input: vi.fn(),
  scrollToTop: vi.fn(),
  scrollToBottom: vi.fn(),
  scrollPages: vi.fn(),
  scrollLines: vi.fn(),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>, options: Record<string, unknown>) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options,
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn((cb: (e: KeyboardEvent) => boolean) => {
        h.keyHandler = cb;
      }),
      input: h.input,
      scrollToTop: h.scrollToTop,
      scrollToBottom: h.scrollToBottom,
      scrollPages: h.scrollPages,
      scrollLines: h.scrollLines,
      buffer: {
        get active() {
          return { type: h.buffer.type, viewportY: 0, baseY: 0 };
        },
        onBufferChange: vi.fn((cb: () => void) => {
          h.bufferChange = cb;
          return { dispose: vi.fn() };
        }),
      },
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      focus: vi.fn(),
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
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
// 滚动命令作用于活动面板:本用例里活动面板恒为 term-panel(终端)。
vi.mock('@/shell/dock/dock-api-ref', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/dock-api-ref')>()),
  getDockApi: () => ({}),
}));
vi.mock('@/shell/dock/group-mru', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/group-mru')>()),
  activePanelInDocument: () => ({ id: 'term-panel', view: { contentComponent: 'terminal' } }),
}));

import TerminalPlugin from '@/core-plugins/TerminalPlugin';
import { coApp } from '@/plugins/co-app';
import { useTerminal } from '@/panels/Terminal/useTerminal';
import { registerTerminalPanelHandles } from '@/panels/Terminal/terminal-panel-handles';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { TERMINAL_ALT_BUFFER_ATTR, TERMINAL_ATTR } from '@/lib/editor-text-focus';

let plugin: TerminalPlugin | undefined;
let host: HTMLElement | null = null;

function Host() {
  const { containerRef, scroll, focus, clear, readText, readViewport } = useTerminal('term-k');
  useEffect(
    () => registerTerminalPanelHandles('term-panel', { focus, openSearch: () => {}, clear, scroll, clipboard: () => {}, readText, readViewport }),
    [focus, clear, scroll, readText, readViewport],
  );
  return createElement('div', { 'data-testid': 'host', ref: containerRef });
}

function mount() {
  const r = render(createElement(Host));
  host = r.getByTestId('host');
}

/** 在终端容器里的输入元素上派发按键(target 在终端内),交给 xterm 自定义键处理并返回 [返回值, 事件]。 */
function press(init: KeyboardEventInit): [boolean, KeyboardEvent] {
  let input = host!.querySelector('textarea');
  if (!input) {
    input = document.createElement('textarea');
    host!.appendChild(input);
  }
  const e = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
  input.dispatchEvent(e);
  return [h.keyHandler!(e), e];
}

describe('useTerminal 接线(mac)', () => {
  let platform: PropertyDescriptor | undefined;
  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
    h.buffer.type = 'normal';
    plugin = new TerminalPlugin(coApp as never, { id: 'core.terminal.test', name: 'Terminal', version: '1.0.0' });
    plugin.onload();
  });
  afterEach(async () => {
    cleanup();
    await plugin?._deactivate();
    vi.clearAllMocks();
    useKeybindingsStore.setState({ overrides: {} });
    if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
  });

  it('终端容器带终端标记;切到备用屏加备用屏标记,切回去掉', () => {
    mount();
    expect(host!.hasAttribute(TERMINAL_ATTR)).toBe(true);
    expect(host!.hasAttribute(TERMINAL_ALT_BUFFER_ATTR)).toBe(false);
    h.buffer.type = 'alternate';
    h.bufferChange!();
    expect(host!.hasAttribute(TERMINAL_ALT_BUFFER_ATTR)).toBe(true);
    h.buffer.type = 'normal';
    h.bufferChange!();
    expect(host!.hasAttribute(TERMINAL_ALT_BUFFER_ATTR)).toBe(false);
  });

  it('主缓冲:⌘Home / ⌘End / PageUp / ⌘PageDown / ⌥⌘PageUp / ⌥⌘PageDown 滚动视口,不往 shell 发字节', async () => {
    mount();
    for (const init of [
      { key: 'Home', metaKey: true },
      { key: 'End', metaKey: true },
      { key: 'PageUp' },
      { key: 'PageDown', metaKey: true },
      { key: 'PageUp', metaKey: true, altKey: true },
      { key: 'PageDown', metaKey: true, altKey: true },
    ]) {
      const [handled, e] = press(init);
      expect(handled, init.key).toBe(false);
      expect(e.defaultPrevented).toBe(true);
    }
    await Promise.resolve();
    expect(h.scrollToTop).toHaveBeenCalledTimes(1);
    expect(h.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(h.scrollPages.mock.calls).toEqual([[-1], [1]]);
    expect(h.scrollLines.mock.calls).toEqual([[-1], [1]]);
    expect(h.input).not.toHaveBeenCalled();
  });

  it('备用屏(vim):⌘Home 不滚动也不交给 xterm(不发 ESC[1;9H);PageUp 交给程序', async () => {
    mount();
    h.buffer.type = 'alternate';
    h.bufferChange!();
    const [handled, e] = press({ key: 'Home', metaKey: true });
    expect(handled).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(press({ key: 'PageUp' })[0]).toBe(true);
    await Promise.resolve();
    expect(h.scrollToTop).not.toHaveBeenCalled();
    expect(h.scrollPages).not.toHaveBeenCalled();
  });

  it('改键生效:scrollToTop 改到 ⌃⌥T → ⌃⌥T 滚到顶;原 ⌘Home 不再滚动、也不交给 xterm', async () => {
    useKeybindingsStore.setState({ overrides: { 'workbench.action.terminal.scrollToTop': 'ctrl+alt+t' } });
    mount();
    expect(press({ key: 'Home', metaKey: true })[0]).toBe(false);
    await Promise.resolve();
    expect(h.scrollToTop).not.toHaveBeenCalled();
    expect(press({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true })[0]).toBe(false);
    await Promise.resolve();
    expect(h.scrollToTop).toHaveBeenCalledTimes(1);
  });

  it('未绑定的 ⌘ + 功能键(⌘Delete / ⌘F5 / ⌘Enter)不交给 xterm;⌘C / ⌘V 照常交给 xterm;⌘← 仍发 ^A', () => {
    mount();
    for (const key of ['Delete', 'F5', 'Enter']) expect(press({ key, metaKey: true })[0], key).toBe(false);
    expect(press({ key: 'c', metaKey: true })[0]).toBe(true);
    expect(press({ key: 'v', metaKey: true })[0]).toBe(true);
    expect(press({ key: 'ArrowLeft', metaKey: true })[0]).toBe(false);
    expect(h.input).toHaveBeenCalledTimes(1);
    expect(h.input).toHaveBeenCalledWith('\x01', true);
  });
});
