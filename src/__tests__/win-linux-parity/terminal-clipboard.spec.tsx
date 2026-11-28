// @vitest-environment jsdom
// BDD: win-linux-parity / 1 终端复制 / 粘贴键(Windows Ctrl+C 有选区 / Ctrl+V,Ctrl+Shift+C / Ctrl+Shift+V)、
// 2 终端获焦时 Ctrl+P 交给「转到文件」、调试键让出
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, useEffect } from 'react';

const h = vi.hoisted(() => ({
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
  selection: '',
  selectionListeners: [] as Array<() => void>,
  textarea: undefined as HTMLTextAreaElement | undefined,
  paste: vi.fn(),
  writeText: vi.fn(async (_text: string) => {}),
  readText: vi.fn(async () => ''),
  active: undefined as unknown,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>, options: Record<string, unknown>) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options,
      loadAddon: vi.fn(),
      open: vi.fn((el: HTMLElement) => {
        const ta = document.createElement('textarea');
        el.appendChild(ta);
        h.textarea = ta;
        (this as { textarea?: HTMLTextAreaElement }).textarea = ta;
      }),
      attachCustomKeyEventHandler: vi.fn((cb: (e: KeyboardEvent) => boolean) => {
        h.keyHandler = cb;
      }),
      hasSelection: () => h.selection.length > 0,
      getSelection: () => h.selection,
      clearSelection: vi.fn(() => {
        h.selection = '';
        for (const l of h.selectionListeners) l();
      }),
      onSelectionChange: vi.fn((cb: () => void) => {
        h.selectionListeners.push(cb);
        return { dispose: vi.fn() };
      }),
      paste: h.paste,
      input: vi.fn(),
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
vi.mock('@/plugins/sandbox-sweep', async (orig) => ({
  ...(await orig<typeof import('@/plugins/sandbox-sweep')>()),
  getCachedClipboard: () => ({ writeText: h.writeText, readText: h.readText }),
}));
vi.mock('@/plugins/settings/values-store', async (orig) => ({
  ...(await orig<typeof import('@/plugins/settings/values-store')>()),
  useSettingValue: <T,>(_k: string, fb: T) => fb,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('@/shell/dock/dock-api-ref', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/dock-api-ref')>()),
  getDockApi: () => ({}),
}));
vi.mock('@/shell/dock/group-mru', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/group-mru')>()),
  activePanelInDocument: () => h.active,
}));

import TerminalPlugin from '@/core-plugins/TerminalPlugin';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { coApp } from '@/plugins/co-app';
import {
  TERMINAL_CLIPBOARD_COMMANDS,
  TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND_ID,
  TERMINAL_COPY_SELECTION_COMMAND_ID,
  TERMINAL_PASTE_COMMAND_ID,
  TERMINAL_YIELDED_DEBUG_COMMAND_IDS,
  isTerminalPickerToggleKey,
  terminalYieldedCommandId,
} from '@/panels/Terminal/terminal-hotkeys';
import { DEBUG_COMMANDS } from '@/panels/Debug/debug-commands';
import { __resetTerminalPanelHandlesForTest, registerTerminalPanelHandles } from '@/panels/Terminal/terminal-panel-handles';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { useTerminal } from '@/panels/Terminal/useTerminal';
import { provideDebugState, TERMINAL_ATTR, TERMINAL_SELECTION_ATTR } from '@/lib/editor-text-focus';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const WIN = 'Win32';
const LINUX = 'Linux x86_64';
const MAC = 'MacIntel';
let platformDescriptor: PropertyDescriptor | undefined;
const setPlatform = (value: string) =>
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => value });

beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  __resetTerminalPanelHandlesForTest();
  useKeybindingsStore.setState({ overrides: {} });
  h.active = undefined;
  if (platformDescriptor) Object.defineProperty(Navigator.prototype, 'platform', platformDescriptor);
});

const noRegistry = { getAll: () => [] };

/** 终端输入区(容器带 TERMINAL_ATTR;selected → 另带选区标记)上派发按键,返回事件。 */
function keyOnTerminal(init: KeyboardEventInit, selected: boolean): KeyboardEvent {
  const host = document.createElement('div');
  host.setAttribute(TERMINAL_ATTR, '');
  if (selected) host.setAttribute(TERMINAL_SELECTION_ATTR, '');
  const input = document.createElement('textarea');
  host.appendChild(input);
  document.body.appendChild(host);
  const e = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
  input.dispatchEvent(e);
  return e;
}

describe('命令定义同 VSCode(terminal.clipboard.contribution)', () => {
  it('id / 英文标题 / when;三语标题齐全', () => {
    expect(TERMINAL_CLIPBOARD_COMMANDS.map((c) => [c.id, c.title, c.when])).toEqual([
      [TERMINAL_COPY_SELECTION_COMMAND_ID, 'Copy Selection', 'terminalTextSelectedFocus'],
      [TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND_ID, 'Copy and Clear Selection', 'terminalTextSelectedFocus'],
      [TERMINAL_PASTE_COMMAND_ID, 'Paste into Active Terminal', 'terminalFocus'],
    ]);
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
      for (const c of TERMINAL_CLIPBOARD_COMMANDS) expect(cat[c.titleKey], c.titleKey).toBeTruthy();
    }
  });
  it('默认键:Windows Ctrl+Shift+C / Ctrl+C / Ctrl+V(+Ctrl+Shift+V);Linux Ctrl+Shift+C / — / Ctrl+Shift+V;mac 无', () => {
    expect(TERMINAL_CLIPBOARD_COMMANDS.map((c) => c.keys.windows)).toEqual([
      { hotkey: 'ctrl+shift+c' },
      { hotkey: 'ctrl+c' },
      { hotkey: 'ctrl+v', secondaryHotkeys: ['ctrl+shift+v'] },
    ]);
    expect(TERMINAL_CLIPBOARD_COMMANDS.map((c) => c.keys.linux)).toEqual([{ hotkey: 'ctrl+shift+c' }, {}, { hotkey: 'ctrl+shift+v' }]);
    expect(TERMINAL_CLIPBOARD_COMMANDS.map((c) => c.keys.mac)).toEqual([{}, {}, {}]);
  });
});

describe('TerminalPlugin 注册复制 / 粘贴命令(按运行平台默认键)', () => {
  function collect(): CommandSpec[] {
    const commands: CommandSpec[] = [];
    const app = {
      panels: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      commands: {
        register: vi.fn((spec: CommandSpec) => {
          commands.push(spec);
          return { dispose: vi.fn() };
        }),
      },
    };
    new TerminalPlugin(app as never, { id: 'core.terminal', name: 'Terminal', version: '1.0.0' }).onload();
    return commands;
  }
  const keysOf = (commands: CommandSpec[]) =>
    TERMINAL_CLIPBOARD_COMMANDS.map((c) => {
      const spec = commands.find((s) => s.id === c.id)!;
      return [spec.hotkey, spec.secondaryHotkeys];
    });

  it('Windows / Linux / mac', () => {
    setPlatform(WIN);
    expect(keysOf(collect())).toEqual([['ctrl+shift+c', undefined], ['ctrl+c', undefined], ['ctrl+v', ['ctrl+shift+v']]]);
    setPlatform(LINUX);
    expect(keysOf(collect())).toEqual([['ctrl+shift+c', undefined], [undefined, undefined], ['ctrl+shift+v', undefined]]);
    setPlatform(MAC);
    expect(keysOf(collect())).toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
  });
  it('执行:作用于活动终端(复制 / 复制并清除 / 粘贴);活动面板不是终端 → 什么都不做', async () => {
    setPlatform(WIN);
    const clipboard = vi.fn();
    registerTerminalPanelHandles('terminal-a', {
      focus: vi.fn(),
      openSearch: vi.fn(),
      clear: vi.fn(),
      scroll: vi.fn(),
      clipboard,
      readText: () => '',
      readViewport: () => null,
    });
    const commands = collect();
    h.active = { id: 'terminal-a', view: { contentComponent: TERMINAL_PANEL_TYPE } };
    for (const c of TERMINAL_CLIPBOARD_COMMANDS) await commands.find((s) => s.id === c.id)!.fn();
    expect(clipboard.mock.calls.map((a) => a[0])).toEqual(['copy', 'copyAndClear', 'paste']);
    clipboard.mockClear();
    h.active = { id: 'editor-1', view: { contentComponent: 'editor' } };
    await commands.find((s) => s.id === TERMINAL_PASTE_COMMAND_ID)!.fn();
    expect(clipboard).not.toHaveBeenCalled();
  });
});

describe('让出判定(platform = other,Windows / Linux 按 navigator.platform 区分)', () => {
  const yielded = (init: KeyboardEventInit, selected: boolean) =>
    terminalYieldedCommandId(keyOnTerminal(init, selected), 'other', {}, noRegistry);

  it('Windows:Ctrl+C 有选区 → 复制并清除;没有选区 → 不让出(照常发 ^C);Ctrl+Shift+C 有选区 → 复制;Ctrl+V / Ctrl+Shift+V → 粘贴', () => {
    setPlatform(WIN);
    expect(yielded({ key: 'c', ctrlKey: true }, true)).toBe(TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND_ID);
    expect(yielded({ key: 'c', ctrlKey: true }, false)).toBeNull();
    expect(yielded({ key: 'C', ctrlKey: true, shiftKey: true }, true)).toBe(TERMINAL_COPY_SELECTION_COMMAND_ID);
    expect(yielded({ key: 'C', ctrlKey: true, shiftKey: true }, false)).toBeNull();
    expect(yielded({ key: 'v', ctrlKey: true }, false)).toBe(TERMINAL_PASTE_COMMAND_ID);
    expect(yielded({ key: 'V', ctrlKey: true, shiftKey: true }, false)).toBe(TERMINAL_PASTE_COMMAND_ID);
  });
  it('Linux:Ctrl+C / Ctrl+V 照常进 shell;Ctrl+Shift+C(有选区)/ Ctrl+Shift+V 让出', () => {
    setPlatform(LINUX);
    expect(yielded({ key: 'c', ctrlKey: true }, true)).toBeNull();
    expect(yielded({ key: 'v', ctrlKey: true }, false)).toBeNull();
    expect(yielded({ key: 'C', ctrlKey: true, shiftKey: true }, true)).toBe(TERMINAL_COPY_SELECTION_COMMAND_ID);
    expect(yielded({ key: 'V', ctrlKey: true, shiftKey: true }, false)).toBe(TERMINAL_PASTE_COMMAND_ID);
  });
  it('mac:⌘C / ⌘V / ⌃C 都不让出(⌘C / ⌘V 走原生复制粘贴)', () => {
    setPlatform(MAC);
    const e = (init: KeyboardEventInit) => terminalYieldedCommandId(keyOnTerminal(init, true), 'mac', {}, noRegistry);
    expect(e({ key: 'c', metaKey: true })).toBeNull();
    expect(e({ key: 'v', metaKey: true })).toBeNull();
    expect(e({ key: 'c', ctrlKey: true })).toBeNull();
  });
  it('焦点不在终端 → 不胜出(编辑器里的 Ctrl+C / Ctrl+V 不受影响)', () => {
    setPlatform(WIN);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    const e = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true, bubbles: true });
    input.dispatchEvent(e);
    expect(terminalYieldedCommandId(e, 'other', {}, noRegistry)).toBeNull();
  });
  it('调试命令(VSCode commandsToSkipShell 含 workbench.action.debug.*):会话停住时 F5 让出,没有会话时进 shell', () => {
    expect([...TERMINAL_YIELDED_DEBUG_COMMAND_IDS]).toEqual(DEBUG_COMMANDS.map((c) => c.id));
    const registry = { getAll: () => DEBUG_COMMANDS.map((c) => ({ id: c.id, title: c.title, hotkey: c.hotkey, when: c.when, fn: () => {} })) };
    const f5 = () => terminalYieldedCommandId(keyOnTerminal({ key: 'F5' }, false), 'other', {}, registry);
    try {
      provideDebugState(() => 'stopped');
      expect(f5()).toBe('workbench.action.debug.continue');
      provideDebugState(() => 'inactive');
      expect(f5()).toBeNull();
    } finally {
      provideDebugState(() => 'inactive');
    }
  });
});

describe('转到文件 / 命令面板的开关键(VSCode commandsToSkipShell 含 quickOpen / showCommands)', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
  it('Windows / Linux Ctrl+P / Ctrl+Shift+P、mac ⌘P 不交给 xterm;mac ⌃P、Win 键 + P、Ctrl+Alt+P 照常进 shell', () => {
    expect(isTerminalPickerToggleKey(key({ key: 'p', ctrlKey: true }), 'other')).toBe(true);
    expect(isTerminalPickerToggleKey(key({ key: 'P', ctrlKey: true, shiftKey: true }), 'other')).toBe(true);
    expect(isTerminalPickerToggleKey(key({ key: 'p', metaKey: true }), 'mac')).toBe(true);
    expect(isTerminalPickerToggleKey(key({ key: 'p', ctrlKey: true }), 'mac')).toBe(false);
    expect(isTerminalPickerToggleKey(key({ key: 'p', metaKey: true }), 'other')).toBe(false);
    expect(isTerminalPickerToggleKey(key({ key: 'p', ctrlKey: true, altKey: true }), 'other')).toBe(false);
    expect(isTerminalPickerToggleKey(key({ key: 'p', ctrlKey: true, isComposing: true }), 'other')).toBe(false);
  });
});

describe('useTerminal 接线', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
    h.selection = '';
    h.selectionListeners = [];
    h.paste.mockClear();
    h.writeText.mockClear();
    h.readText.mockReset();
    h.readText.mockResolvedValue('');
  });
  let original: CommandRegistry;
  beforeEach(() => {
    original = coApp.commands;
  });
  afterEach(() => {
    (coApp as { commands: CommandRegistry }).commands = original;
  });

  /** 同 TerminalPanelView:注册面板句柄(clipboard = useTerminal 的 runClipboard),活动面板 = 本终端。 */
  function Host() {
    const { containerRef, runClipboard } = useTerminal('term-k');
    useEffect(
      () =>
        registerTerminalPanelHandles('terminal-k', {
          focus: () => {},
          openSearch: () => {},
          clear: () => {},
          scroll: () => {},
          clipboard: runClipboard,
          readText: () => '',
          readViewport: () => null,
        }),
      [runClipboard],
    );
    return createElement('div', { ref: containerRef });
  }

  /** 按平台装好 TerminalPlugin 的命令(真实注册表),挂载终端。 */
  function mount(platform: string) {
    setPlatform(platform);
    const registry = new CommandRegistry(platform === MAC ? 'mac' : 'other');
    (coApp as { commands: CommandRegistry }).commands = registry;
    new TerminalPlugin(coApp as never, { id: 'core.terminal', name: 'Terminal', version: '1.0.0' }).onload();
    h.active = { id: 'terminal-k', view: { contentComponent: TERMINAL_PANEL_TYPE } };
    render(createElement(Host));
  }
  const select = (text: string) =>
    act(() => {
      h.selection = text;
      for (const l of h.selectionListeners) l();
    });
  /** 在 xterm 输入区上按键,返回 [交给 xterm?, 事件]。 */
  function press(init: KeyboardEventInit): [boolean, KeyboardEvent] {
    const e = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
    h.textarea!.dispatchEvent(e);
    return [h.keyHandler!(e), e];
  }
  const flush = () => act(async () => {});

  it('选区变化同步到终端容器的选区标记(terminalTextSelectedFocus)', () => {
    mount(WIN);
    const host = h.textarea!.parentElement!;
    expect(host.hasAttribute(TERMINAL_SELECTION_ATTR)).toBe(false);
    select('abc');
    expect(host.hasAttribute(TERMINAL_SELECTION_ATTR)).toBe(true);
    select('');
    expect(host.hasAttribute(TERMINAL_SELECTION_ATTR)).toBe(false);
  });

  it('Windows:有选区 Ctrl+C → 复制并清除选区,不发 ^C;再按 Ctrl+C(无选区)→ 交给 xterm 发 ^C', async () => {
    mount(WIN);
    select('hello');
    const [handled, e] = press({ key: 'c', ctrlKey: true });
    expect(handled).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    await flush();
    expect(h.writeText).toHaveBeenCalledWith('hello');
    expect(h.selection).toBe('');
    expect(press({ key: 'c', ctrlKey: true })[0]).toBe(true);
  });

  it('Windows:Ctrl+Shift+C 复制但保留选区;Ctrl+V → 读剪贴板、净化控制字符后 term.paste,不发 ^V', async () => {
    mount(WIN);
    select('keep');
    expect(press({ key: 'C', ctrlKey: true, shiftKey: true })[0]).toBe(false);
    await flush();
    expect(h.writeText).toHaveBeenCalledWith('keep');
    expect(h.selection).toBe('keep');
    h.readText.mockResolvedValue('ls\x1b[201~rm');
    const [handled, e] = press({ key: 'v', ctrlKey: true });
    expect(handled).toBe(false);
    expect(e.defaultPrevented).toBe(true); // 不再触发原生 paste 事件(免得粘两次)
    await flush();
    expect(h.paste).toHaveBeenCalledWith('ls[201~rm');
  });

  it('Linux:Ctrl+C(有选区)/ Ctrl+V 照常交给 xterm;Ctrl+Shift+C 复制、Ctrl+Shift+V 粘贴', async () => {
    mount(LINUX);
    select('x');
    expect(press({ key: 'c', ctrlKey: true })[0]).toBe(true);
    expect(press({ key: 'v', ctrlKey: true })[0]).toBe(true);
    expect(press({ key: 'C', ctrlKey: true, shiftKey: true })[0]).toBe(false);
    h.readText.mockResolvedValue('echo hi');
    expect(press({ key: 'V', ctrlKey: true, shiftKey: true })[0]).toBe(false);
    await flush();
    expect(h.writeText).toHaveBeenCalledWith('x');
    expect(h.paste).toHaveBeenCalledWith('echo hi');
  });

  it('mac:⌘C / ⌘V / ⌃C 都照旧交给 xterm(原生复制粘贴 / ^C)', () => {
    mount(MAC);
    select('x');
    expect(press({ key: 'c', metaKey: true })[0]).toBe(true);
    expect(press({ key: 'v', metaKey: true })[0]).toBe(true);
    expect(press({ key: 'c', ctrlKey: true })[0]).toBe(true);
    expect(h.writeText).not.toHaveBeenCalled();
  });

  it('Windows / Linux:Ctrl+P 不交给 xterm、不截冒泡(交给 picker 监听);mac ⌃P 照常进 shell', () => {
    mount(LINUX);
    const [handled, e] = press({ key: 'p', ctrlKey: true });
    expect(handled).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    cleanup();
    mount(MAC);
    expect(press({ key: 'p', ctrlKey: true })[0]).toBe(true);
  });
});
