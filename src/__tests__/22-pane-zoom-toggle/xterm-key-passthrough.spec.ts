// BDD: 22-pane-zoom-toggle / xterm Shift+(Cmd|Ctrl)+Enter passthrough
//
// shouldSkipXtermKey 命中条件:
//   keydown + Enter + Shift + (Meta || Ctrl) + !Alt + !isComposing
// 命中后 customKeyEventHandler return false → xterm 不发 \r 到 PTY,
// document keydown bubble 到 useCommandHotkeys 派发 terminal.zoom.toggle。

import { describe, it, expect } from 'vitest';
import { shouldSkipXtermKey } from '@continuo-terminal/react-terminal';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminalSearchHotkey, isTerminalZoomHotkey } from '../../panels/Terminal/terminal-hotkeys';

function makeKey(init: Partial<KeyboardEventInit> & { type?: string; isComposing?: boolean }) {
  const type = init.type ?? 'keydown';
  const ev = new KeyboardEvent(type, {
    key: 'Enter',
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
  });
  if (init.isComposing !== undefined) {
    Object.defineProperty(ev, 'isComposing', { value: init.isComposing });
  }
  if (init.key !== undefined) {
    Object.defineProperty(ev, 'key', { value: init.key });
  }
  return ev;
}

describe('shouldSkipXtermKey (T5)', () => {
  it('Shift+Cmd+Enter (macOS) → true', () => {
    expect(shouldSkipXtermKey(makeKey({ shiftKey: true, metaKey: true }))).toBe(true);
  });

  it('Shift+Ctrl+Enter (Win/Linux) → true', () => {
    expect(shouldSkipXtermKey(makeKey({ shiftKey: true, ctrlKey: true }))).toBe(true);
  });

  it('Shift+Enter (无 mod) → false (仍走 Shift+Enter mapping)', () => {
    expect(shouldSkipXtermKey(makeKey({ shiftKey: true }))).toBe(false);
  });

  it('Cmd+Enter (无 shift) → false', () => {
    expect(shouldSkipXtermKey(makeKey({ metaKey: true }))).toBe(false);
  });

  it('Enter 单独 → false', () => {
    expect(shouldSkipXtermKey(makeKey({}))).toBe(false);
  });

  it('Shift+Cmd+Alt+Enter (altKey 干扰) → false', () => {
    expect(
      shouldSkipXtermKey(makeKey({ shiftKey: true, metaKey: true, altKey: true })),
    ).toBe(false);
  });

  it('IME composing Shift+Cmd+Enter → false', () => {
    expect(
      shouldSkipXtermKey(
        makeKey({ shiftKey: true, metaKey: true, isComposing: true }),
      ),
    ).toBe(false);
  });

  it('keyup type → false (只接受 keydown)', () => {
    expect(
      shouldSkipXtermKey(
        makeKey({ shiftKey: true, metaKey: true, type: 'keyup' }),
      ),
    ).toBe(false);
  });

  it('非 Enter key (e.g. Shift+Cmd+T) → false', () => {
    expect(
      shouldSkipXtermKey(makeKey({ shiftKey: true, metaKey: true, key: 'T' })),
    ).toBe(false);
  });
});

// 让出判定与命令同一热键串、按平台匹配(isTerminalZoomHotkey):mac 上 mod 只认 Cmd —— Shift+Ctrl+Enter 不让出(照常
// 发回车给 PTY),否则既不发回车、缩放命令又不匹配,按键被吞。
describe('isTerminalZoomHotkey(按平台)', () => {
  it('mac:Shift+Cmd+Enter 让出;Shift+Ctrl+Enter 不让出', () => {
    expect(isTerminalZoomHotkey(makeKey({ shiftKey: true, metaKey: true }), 'mac')).toBe(true);
    expect(isTerminalZoomHotkey(makeKey({ shiftKey: true, ctrlKey: true }), 'mac')).toBe(false);
  });
  it('Windows / Linux:Shift+Ctrl+Enter 让出;Shift+Win(meta)+Enter 不让出', () => {
    expect(isTerminalZoomHotkey(makeKey({ shiftKey: true, ctrlKey: true }), 'other')).toBe(true);
    expect(isTerminalZoomHotkey(makeKey({ shiftKey: true, metaKey: true }), 'other')).toBe(false);
  });
  it('输入法组合中 / keyup → 不让出', () => {
    expect(isTerminalZoomHotkey(makeKey({ shiftKey: true, metaKey: true, isComposing: true }), 'mac')).toBe(false);
    expect(isTerminalZoomHotkey(makeKey({ type: 'keyup', shiftKey: true, metaKey: true }), 'mac')).toBe(false);
  });
  it('useTerminal 用 isTerminalZoomHotkey 判让出(不再用不分平台的 shouldSkipXtermKey)', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Terminal/useTerminal.ts'), 'utf-8');
    expect(src).toContain('isTerminalZoomHotkey(event)');
    expect(src).toContain('isTerminalSearchHotkey(event)');
    expect(src).not.toContain('shouldSkipXtermKey');
    expect(src).not.toContain('isSearchHotkey(');
  });
});

// 让出判定按生效绑定:改绑 → 跟随新键、原默认键照常进 shell;解绑 → 不再让出。
describe('终端让出热键按生效绑定(含用户改绑 / 解绑)', () => {
  const f = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  it('缩放改绑为 mod+shift+z:原 Shift+Cmd+Enter 不让出,新键让出', () => {
    const o = { 'terminal.zoom.toggle': 'mod+shift+z' };
    expect(isTerminalZoomHotkey(makeKey({ shiftKey: true, metaKey: true }), 'mac', o)).toBe(false);
    expect(isTerminalZoomHotkey(f({ key: 'z', shiftKey: true, metaKey: true }), 'mac', o)).toBe(true);
  });
  it('缩放解绑:不让出', () => {
    expect(
      isTerminalZoomHotkey(makeKey({ shiftKey: true, metaKey: true }), 'mac', { 'terminal.zoom.toggle': '' }),
    ).toBe(false);
  });
  it('搜索:默认 Ctrl+F(非 mac)让出;解绑后 Ctrl+F 进 shell', () => {
    expect(isTerminalSearchHotkey(f({ key: 'f', ctrlKey: true }), 'other', {})).toBe(true);
    expect(isTerminalSearchHotkey(f({ key: 'f', ctrlKey: true }), 'other', { 'terminal.search.toggle': '' })).toBe(false);
    expect(isTerminalSearchHotkey(f({ key: 'f', metaKey: true }), 'mac', {})).toBe(true);
    expect(isTerminalSearchHotkey(f({ key: 'f', metaKey: true, shiftKey: true }), 'mac', {})).toBe(false);
  });
});

