// @vitest-environment jsdom
// BDD: terminal-scroll-commands / 1-3 终端滚动命令(定义 / 注册 / 让出判定)与 mac 未绑定 ⌘ 组合兜底丢弃
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ active: undefined as unknown }));
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
import {
  TERMINAL_SCROLL_COMMANDS,
  isTerminalUnboundMetaKey,
  terminalScrollDefaultHotkeys,
  terminalYieldedCommandId,
} from '@/panels/Terminal/terminal-hotkeys';
import {
  __resetTerminalPanelHandlesForTest,
  registerTerminalPanelHandles,
} from '@/panels/Terminal/terminal-panel-handles';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { TERMINAL_ALT_BUFFER_ATTR, TERMINAL_ATTR } from '@/lib/editor-text-focus';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const TOP = 'workbench.action.terminal.scrollToTop';
const BOTTOM = 'workbench.action.terminal.scrollToBottom';
const PAGE_UP = 'workbench.action.terminal.scrollUpPage';
const PAGE_DOWN = 'workbench.action.terminal.scrollDownPage';
const LINE_UP = 'workbench.action.terminal.scrollUp';
const LINE_DOWN = 'workbench.action.terminal.scrollDown';
const noRegistry = { getAll: () => [] };

/** 在 el 上派发按键(target = el),返回事件供判定。 */
function keyOn(el: Element, init: KeyboardEventInit, type = 'keydown'): KeyboardEvent {
  const e = new KeyboardEvent(type, { cancelable: true, bubbles: true, ...init });
  el.dispatchEvent(e);
  return e;
}

function terminalInput(alt = false): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute(TERMINAL_ATTR, '');
  if (alt) host.setAttribute(TERMINAL_ALT_BUFFER_ATTR, '');
  const input = document.createElement('textarea');
  host.appendChild(input);
  document.body.appendChild(host);
  return input;
}

afterEach(() => {
  document.body.innerHTML = '';
  __resetTerminalPanelHandlesForTest();
  h.active = undefined;
});

describe('命令定义同 VSCode', () => {
  it('六个命令的 id / 英文标题', () => {
    expect(TERMINAL_SCROLL_COMMANDS.map((c) => [c.id, c.title])).toEqual([
      [TOP, 'Scroll to Top'],
      [BOTTOM, 'Scroll to Bottom'],
      [PAGE_UP, 'Scroll Up (Page)'],
      [PAGE_DOWN, 'Scroll Down (Page)'],
      [LINE_UP, 'Scroll Up (Line)'],
      [LINE_DOWN, 'Scroll Down (Line)'],
    ]);
  });
  it('默认键:mac ⌘Home / ⌘End / PageUp(+⌘PageUp)/ PageDown(+⌘PageDown)/ ⌥⌘PageUp / ⌥⌘PageDown', () => {
    expect(TERMINAL_SCROLL_COMMANDS.map((c) => terminalScrollDefaultHotkeys(c, 'mac'))).toEqual([
      { hotkey: 'mod+home' },
      { hotkey: 'mod+end' },
      { hotkey: 'pageup', secondaryHotkeys: ['mod+pageup'] },
      { hotkey: 'pagedown', secondaryHotkeys: ['mod+pagedown'] },
      { hotkey: 'mod+alt+pageup' },
      { hotkey: 'mod+alt+pagedown' },
    ]);
  });
  it('默认键:Windows / Linux Ctrl+Home / Ctrl+End / ⇧PageUp / ⇧PageDown / Ctrl+Alt+PageUp / Ctrl+Alt+PageDown', () => {
    expect(TERMINAL_SCROLL_COMMANDS.map((c) => terminalScrollDefaultHotkeys(c, 'other'))).toEqual([
      { hotkey: 'mod+home' },
      { hotkey: 'mod+end' },
      { hotkey: 'shift+pageup' },
      { hotkey: 'shift+pagedown' },
      { hotkey: 'mod+alt+pageup' },
      { hotkey: 'mod+alt+pagedown' },
    ]);
  });
  it('三语标题齐全', () => {
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
      for (const c of TERMINAL_SCROLL_COMMANDS) expect(cat[c.titleKey], `${c.titleKey}`).toBeTruthy();
    }
  });
});

describe('TerminalPlugin 注册滚动命令', () => {
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

  it('带三语 titleKey、分类「终端」、when = terminalNormalBufferFocus、按平台默认键', () => {
    const commands = collect();
    for (const c of TERMINAL_SCROLL_COMMANDS) {
      const spec = commands.find((s) => s.id === c.id);
      expect(spec, c.id).toBeDefined();
      expect(spec).toMatchObject({ titleKey: c.titleKey, categoryKey: 'commands.terminal.category', when: 'terminalNormalBufferFocus' });
      expect(spec!.hotkey).toBeTruthy();
    }
  });
  it('执行:活动面板是终端 → 按动作滚动该终端;不是终端 → 什么都不做', async () => {
    const scroll = vi.fn();
    registerTerminalPanelHandles('terminal-a', {
      focus: vi.fn(),
      openSearch: vi.fn(),
      clear: vi.fn(),
      scroll,
      readText: () => '',
      readViewport: () => null,
    });
    const commands = collect();
    h.active = { id: 'terminal-a', view: { contentComponent: TERMINAL_PANEL_TYPE } };
    for (const c of TERMINAL_SCROLL_COMMANDS) await commands.find((s) => s.id === c.id)!.fn();
    expect(scroll.mock.calls.map((a) => a[0])).toEqual(['top', 'bottom', 'pageUp', 'pageDown', 'lineUp', 'lineDown']);
    scroll.mockClear();
    h.active = { id: 'terminal-a', view: { contentComponent: 'editor' } };
    await commands.find((s) => s.id === TOP)!.fn();
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('让出判定:终端主缓冲获焦时滚动键让出给命令', () => {
  it('mac:⌘Home / ⌘End / PageUp / ⌘PageUp / PageDown / ⌘PageDown / ⌥⌘PageUp / ⌥⌘PageDown', () => {
    const el = terminalInput();
    const yielded = (init: KeyboardEventInit) => terminalYieldedCommandId(keyOn(el, init), 'mac', {}, noRegistry);
    expect(yielded({ key: 'Home', metaKey: true })).toBe(TOP);
    expect(yielded({ key: 'End', metaKey: true })).toBe(BOTTOM);
    expect(yielded({ key: 'PageUp' })).toBe(PAGE_UP);
    expect(yielded({ key: 'PageUp', metaKey: true })).toBe(PAGE_UP);
    expect(yielded({ key: 'PageDown' })).toBe(PAGE_DOWN);
    expect(yielded({ key: 'PageDown', metaKey: true })).toBe(PAGE_DOWN);
    expect(yielded({ key: 'PageUp', metaKey: true, altKey: true })).toBe(LINE_UP);
    expect(yielded({ key: 'PageDown', metaKey: true, altKey: true })).toBe(LINE_DOWN);
  });
  it('Windows / Linux:Ctrl+Home / Ctrl+End / ⇧PageUp / ⇧PageDown / Ctrl+Alt+PageUp / Ctrl+Alt+PageDown(不只 Meta 才让出)', () => {
    const el = terminalInput();
    const yielded = (init: KeyboardEventInit) => terminalYieldedCommandId(keyOn(el, init), 'other', {}, noRegistry);
    expect(yielded({ key: 'Home', ctrlKey: true })).toBe(TOP);
    expect(yielded({ key: 'End', ctrlKey: true })).toBe(BOTTOM);
    expect(yielded({ key: 'PageUp', shiftKey: true })).toBe(PAGE_UP);
    expect(yielded({ key: 'PageDown', shiftKey: true })).toBe(PAGE_DOWN);
    expect(yielded({ key: 'PageUp', ctrlKey: true, altKey: true })).toBe(LINE_UP);
    expect(yielded({ key: 'PageDown', ctrlKey: true, altKey: true })).toBe(LINE_DOWN);
    expect(yielded({ key: 'PageUp' })).toBeNull();
  });
  it('备用屏(vim / less)里不让出:按键交给程序', () => {
    const el = terminalInput(true);
    expect(terminalYieldedCommandId(keyOn(el, { key: 'Home', metaKey: true }), 'mac', {}, noRegistry)).toBeNull();
    expect(terminalYieldedCommandId(keyOn(el, { key: 'PageUp' }), 'mac', {}, noRegistry)).toBeNull();
    expect(terminalYieldedCommandId(keyOn(el, { key: 'Home', ctrlKey: true }), 'other', {}, noRegistry)).toBeNull();
  });
  it('焦点不在终端:不胜出为滚动命令', () => {
    const outside = document.createElement('textarea');
    document.body.appendChild(outside);
    expect(terminalYieldedCommandId(keyOn(outside, { key: 'Home', metaKey: true }), 'mac', {}, noRegistry)).toBeNull();
  });
  it('改键跟随新键,原键不再让出;解绑后不让出', () => {
    const el = terminalInput();
    const o = { [TOP]: 'ctrl+alt+t' };
    expect(terminalYieldedCommandId(keyOn(el, { key: 'Home', metaKey: true }), 'mac', o, noRegistry)).toBeNull();
    expect(terminalYieldedCommandId(keyOn(el, { key: 't', ctrlKey: true, altKey: true }), 'mac', o, noRegistry)).toBe(TOP);
    expect(terminalYieldedCommandId(keyOn(el, { key: 'End', metaKey: true }), 'mac', { [BOTTOM]: '' }, noRegistry)).toBeNull();
  });
});

describe('mac 未绑定的 ⌘ + 非字符键不交给 xterm', () => {
  const ev = (init: KeyboardEventInit, type = 'keydown') => new KeyboardEvent(type, { cancelable: true, ...init });
  it('⌘Home / ⌘End / ⌘PageUp / ⌘PageDown / ⌘Delete / ⌘Insert / ⌘F5 / ⌘Enter / ⌘Tab / ⌘Escape / ⌘↑ / ⌃⌘Home → 丢弃', () => {
    for (const key of ['Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert', 'F5', 'Enter', 'Tab', 'Escape', 'ArrowUp']) {
      expect(isTerminalUnboundMetaKey(ev({ key, metaKey: true }), 'mac'), key).toBe(true);
    }
    expect(isTerminalUnboundMetaKey(ev({ key: 'Home', metaKey: true, ctrlKey: true }), 'mac')).toBe(true);
    expect(isTerminalUnboundMetaKey(ev({ key: 'Backspace', metaKey: true, shiftKey: true }), 'mac')).toBe(true);
  });
  it('⌘ + 字符键(⌘C / ⌘V / ⌘A / ⌘K / ⌘1)、单按 ⌘、不带 ⌘、keyup、输入法组合中、其它平台 → 不丢弃', () => {
    for (const key of ['c', 'v', 'a', 'k', '1', 'Meta']) {
      expect(isTerminalUnboundMetaKey(ev({ key, metaKey: true }), 'mac'), key).toBe(false);
    }
    expect(isTerminalUnboundMetaKey(ev({ key: 'Home' }), 'mac')).toBe(false);
    expect(isTerminalUnboundMetaKey(ev({ key: 'Home', metaKey: true }, 'keyup'), 'mac')).toBe(false);
    expect(isTerminalUnboundMetaKey(ev({ key: 'Home', metaKey: true, isComposing: true }), 'mac')).toBe(false);
    expect(isTerminalUnboundMetaKey(ev({ key: 'Home', metaKey: true }), 'other')).toBe(false);
  });
});
