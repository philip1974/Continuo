// @vitest-environment jsdom
// BDD: terminal-vscode-parity / 10 mac 行内编辑键 ⌘← / ⌘→ / ⌘⌫ / ⌥← / ⌥→(VSCode registerSendSequenceKeybinding mac 默认)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
  input: vi.fn(),
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

import { terminalSendSequenceForKey } from '@/panels/Terminal/terminal-hotkeys';
import { useTerminal } from '@/panels/Terminal/useTerminal';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';

const key = (init: KeyboardEventInit, type = 'keydown') =>
  new KeyboardEvent(type, { cancelable: true, bubbles: true, ...init });

describe('按键 → 控制序列(仅 mac)', () => {
  it('⌘← = ^A 行首,⌘→ = ^E 行尾,⌘⌫ = ^U 删到行首', () => {
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft', metaKey: true }), 'mac')).toBe('\x01');
    expect(terminalSendSequenceForKey(key({ key: 'ArrowRight', metaKey: true }), 'mac')).toBe('\x05');
    expect(terminalSendSequenceForKey(key({ key: 'Backspace', metaKey: true }), 'mac')).toBe('\x15');
  });
  it('⌥← = ESC b、⌥→ = ESC f(按单词移动;xterm 6 默认发 ESC[1;3D,shell 不认)', () => {
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft', altKey: true }), 'mac')).toBe('\x1bb');
    expect(terminalSendSequenceForKey(key({ key: 'ArrowRight', altKey: true }), 'mac')).toBe('\x1bf');
  });
  it('其它平台 / 多余修饰键 / 非 keydown / 输入法组合中 / 其它键 → null(交给 xterm)', () => {
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft', metaKey: true }), 'other')).toBeNull();
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft', ctrlKey: true }), 'mac')).toBeNull();
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft', metaKey: true, shiftKey: true }), 'mac')).toBeNull();
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft', metaKey: true, altKey: true }), 'mac')).toBeNull();
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft', metaKey: true }, 'keyup'), 'mac')).toBeNull();
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft', metaKey: true, isComposing: true }), 'mac')).toBeNull();
    expect(terminalSendSequenceForKey(key({ key: 'Backspace', altKey: true }), 'mac')).toBeNull();
    expect(terminalSendSequenceForKey(key({ key: 'ArrowLeft' }), 'mac')).toBeNull();
  });
});

describe('useTerminal 接线(mac)', () => {
  let platform: PropertyDescriptor | undefined;
  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useKeybindingsStore.setState({ overrides: {} });
    if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
  });
  function Host() {
    const { containerRef } = useTerminal('term-k');
    return createElement('div', { ref: containerRef });
  }

  it('⌘← 经 term.input 发 ^A(走 onData 同一写入路径),xterm 不再处理、事件不冒泡', () => {
    render(createElement(Host));
    const e = key({ key: 'ArrowLeft', metaKey: true });
    const stop = vi.spyOn(e, 'stopPropagation');
    expect(h.keyHandler!(e)).toBe(false);
    expect(h.input).toHaveBeenCalledWith('\x01', true);
    expect(e.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(h.keyHandler!(key({ key: 'Backspace', metaKey: true }))).toBe(false);
    expect(h.input).toHaveBeenLastCalledWith('\x15', true);
  });
  it('普通方向键照常交给 xterm', () => {
    render(createElement(Host));
    expect(h.keyHandler!(key({ key: 'ArrowLeft' }))).toBe(true);
    expect(h.input).not.toHaveBeenCalled();
  });
  it('用户把 ⌘← 绑给终端让出的命令(清屏)→ 让出给命令,不发序列', () => {
    useKeybindingsStore.setState({ overrides: { 'terminal.clear': 'mod+left' } });
    render(createElement(Host));
    expect(h.keyHandler!(key({ key: 'ArrowLeft', metaKey: true }))).toBe(false);
    expect(h.input).not.toHaveBeenCalled();
  });
});
