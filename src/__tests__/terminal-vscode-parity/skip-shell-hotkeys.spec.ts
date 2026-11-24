// @vitest-environment jsdom
// BDD: terminal-vscode-parity / 1-2 终端让出工作台命令键(commandsToSkipShell)+ ⌘K 清屏
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TERMINAL_CLEAR_COMMAND,
  WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND,
  WORKBENCH_SAVE_COMMAND,
  runTerminalCommandFromKey,
  terminalClearDefaultHotkey,
  terminalYieldedCommandId,
} from '../../panels/Terminal/terminal-hotkeys';
import { coApp } from '../../plugins/co-app';
import { buildCompiledBindings } from '../../plugins/command-palette/useCommandHotkeys';
import {
  __resetTerminalPanelHandlesForTest,
  clearTerminalPanel,
  registerTerminalPanelHandles,
} from '../../panels/Terminal/terminal-panel-handles';

const key = (init: KeyboardEventInit, type = 'keydown') =>
  new KeyboardEvent(type, { cancelable: true, bubbles: true, ...init });
const noRegistry = { get: () => undefined };

describe('命令 id / 默认键与注册方约定一致', () => {
  it('closeActiveEditor = mod+w,save = mod+s,clear 仅 mac 默认 mod+k', () => {
    expect(WORKBENCH_CLOSE_ACTIVE_EDITOR_COMMAND).toEqual({ id: 'workbench.action.closeActiveEditor', hotkey: 'mod+w' });
    expect(WORKBENCH_SAVE_COMMAND).toEqual({ id: 'workbench.action.files.save', hotkey: 'mod+s' });
    expect(TERMINAL_CLEAR_COMMAND.id).toBe('terminal.clear');
    // VSCode workbench.action.terminal.clear:primary 0、mac ⌘K —— Win/Linux 无默认键(Ctrl+K 是 readline 删到行尾)
    expect(terminalClearDefaultHotkey('mac')).toBe('mod+k');
    expect(terminalClearDefaultHotkey('other')).toBeUndefined();
  });
});

describe('终端让出的键按生效绑定判定', () => {
  it('mac:⌘W / ⌘S / ⌘K 让出;Ctrl+W / Ctrl+S / Ctrl+K 照常进 shell', () => {
    expect(terminalYieldedCommandId(key({ key: 'w', metaKey: true }), 'mac', {}, noRegistry)).toBe('workbench.action.closeActiveEditor');
    expect(terminalYieldedCommandId(key({ key: 's', metaKey: true }), 'mac', {}, noRegistry)).toBe('workbench.action.files.save');
    expect(terminalYieldedCommandId(key({ key: 'k', metaKey: true }), 'mac', {}, noRegistry)).toBe('terminal.clear');
    for (const k of ['w', 's', 'k']) {
      expect(terminalYieldedCommandId(key({ key: k, ctrlKey: true }), 'mac', {}, noRegistry)).toBeNull();
    }
  });
  it('Windows / Linux:Ctrl+W / Ctrl+S / Ctrl+K 照常进 shell(同 VSCode:关闭 / 保存不在 commandsToSkipShell,只靠 metaKey 让出)', () => {
    for (const k of ['w', 's', 'k']) {
      expect(terminalYieldedCommandId(key({ key: k, ctrlKey: true }), 'other', {}, noRegistry)).toBeNull();
    }
  });
  it('Windows / Linux:已注册命令的默认键也不让 Ctrl+W / Ctrl+S 离开终端', () => {
    const registry = { get: (id: string) => ({ id, hotkey: id === 'terminal.clear' ? undefined : id.endsWith('save') ? 'mod+s' : 'mod+w' }) };
    expect(terminalYieldedCommandId(key({ key: 'w', ctrlKey: true }), 'other', {}, registry)).toBeNull();
    expect(terminalYieldedCommandId(key({ key: 's', ctrlKey: true }), 'other', {}, registry)).toBeNull();
    expect(terminalYieldedCommandId(key({ key: 'k', ctrlKey: true }), 'other', {}, registry)).toBeNull();
  });
  it('Windows / Linux:用户给 terminal.clear 绑定 Ctrl+K → 让出(它在 commandsToSkipShell 里);关闭命令改绑到带 Meta 的键 → 让出', () => {
    expect(terminalYieldedCommandId(key({ key: 'k', ctrlKey: true }), 'other', { 'terminal.clear': 'mod+k' }, noRegistry)).toBe('terminal.clear');
    expect(
      terminalYieldedCommandId(key({ key: 'w', metaKey: true }), 'other', { 'workbench.action.closeActiveEditor': 'cmd+w' }, noRegistry),
    ).toBe('workbench.action.closeActiveEditor');
  });
  it('Windows / Linux:全局热键分发不再为 terminal.clear 拦 Ctrl+K(无默认绑定)', () => {
    const spec = { id: 'terminal.clear', title: 'Clear Terminal', fn: () => {}, hotkey: terminalClearDefaultHotkey('other') };
    expect(buildCompiledBindings([spec], 'other')).toHaveLength(0);
    expect(buildCompiledBindings([{ ...spec, hotkey: terminalClearDefaultHotkey('mac') }], 'mac')).toHaveLength(1);
  });
  it('mac:关闭 / 保存改绑到不带 ⌘ 的键 → 不让出(进 shell,同 VSCode)', () => {
    expect(
      terminalYieldedCommandId(key({ key: 'w', ctrlKey: true, altKey: true }), 'mac', { 'workbench.action.closeActiveEditor': 'ctrl+alt+w' }, noRegistry),
    ).toBeNull();
  });
  it('改绑:跟随新键,原默认键照常进 shell;解绑:不再让出', () => {
    const o = { 'workbench.action.files.save': 'mod+shift+s' };
    expect(terminalYieldedCommandId(key({ key: 's', metaKey: true }), 'mac', o, noRegistry)).toBeNull();
    expect(terminalYieldedCommandId(key({ key: 's', metaKey: true, shiftKey: true }), 'mac', o, noRegistry)).toBe('workbench.action.files.save');
    expect(terminalYieldedCommandId(key({ key: 'k', metaKey: true }), 'mac', { 'terminal.clear': '' }, noRegistry)).toBeNull();
  });
  it('命令已注册时以注册的默认 hotkey 为准(不依赖兜底常量)', () => {
    const registry = { get: (id: string) => (id === 'workbench.action.closeActiveEditor' ? { id, hotkey: 'mod+alt+w' } : undefined) };
    expect(terminalYieldedCommandId(key({ key: 'w', metaKey: true }), 'mac', {}, registry)).toBeNull();
    expect(terminalYieldedCommandId(key({ key: 'w', metaKey: true, altKey: true }), 'mac', {}, registry)).toBe('workbench.action.closeActiveEditor');
  });
  it('输入法组合中 / keyup 不让出', () => {
    const composing = key({ key: 'w', metaKey: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    expect(terminalYieldedCommandId(composing, 'mac', {}, noRegistry)).toBeNull();
    expect(terminalYieldedCommandId(key({ key: 'w', metaKey: true }, 'keyup'), 'mac', {}, noRegistry)).toBeNull();
  });
});

describe('runTerminalCommandFromKey', () => {
  afterEach(() => vi.restoreAllMocks());
  it('命令已注册:直接执行并截住冒泡', async () => {
    const fn = vi.fn();
    const d = coApp.commands.register({ id: 'workbench.action.files.save', title: 'Save', fn });
    const ev = key({ key: 's', metaKey: true });
    const stop = vi.spyOn(ev, 'stopPropagation');
    runTerminalCommandFromKey(ev, 'workbench.action.files.save');
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    d.dispose();
  });
  it('命令尚未注册:不截冒泡(交给全局分发),也不报错', () => {
    const ev = key({ key: 'w', metaKey: true });
    const stop = vi.spyOn(ev, 'stopPropagation');
    expect(() => runTerminalCommandFromKey(ev, 'workbench.action.closeActiveEditor')).not.toThrow();
    expect(stop).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('terminal.clear 经面板句柄清屏', () => {
  it('clearTerminalPanel 调对应面板的 clear 句柄;未注册 no-op', () => {
    __resetTerminalPanelHandlesForTest();
    const clear = vi.fn();
    registerTerminalPanelHandles('terminal-a', { focus: vi.fn(), openSearch: vi.fn(), clear, readText: vi.fn(() => '') });
    clearTerminalPanel('terminal-a');
    expect(clear).toHaveBeenCalledTimes(1);
    expect(() => clearTerminalPanel('terminal-missing')).not.toThrow();
  });
  it('TerminalPlugin 注册 terminal.clear(默认键按平台,带 titleKey),仅活动面板是终端时清屏', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/core-plugins/TerminalPlugin.ts', 'utf-8');
    expect(src).toContain('TERMINAL_CLEAR_COMMAND.id');
    expect(src).toContain('hotkey: terminalClearDefaultHotkey(detectPlatform())');
    expect(src).toContain("titleKey: 'commands.terminal.clear.title'");
    expect(src).toContain('clearTerminalPanel(active.id)');
  });
  it('三语标题齐全', async () => {
    const { en } = await import('../../../electron/shared/i18n-locales/en');
    const { zh } = await import('../../../electron/shared/i18n-locales/zh');
    const { ko } = await import('../../../electron/shared/i18n-locales/ko');
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
      expect(cat['commands.terminal.clear.title']).toBeTruthy();
    }
  });
  it('useTerminal 在 xterm 键处理里按 terminalYieldedCommandId 让出', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/panels/Terminal/useTerminal.ts', 'utf-8');
    expect(src).toContain('terminalYieldedCommandId(event)');
    expect(src).toContain('runTerminalCommandFromKey(event, yielded)');
  });
});
