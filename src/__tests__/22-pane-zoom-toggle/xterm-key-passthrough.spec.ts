// BDD: 22-pane-zoom-toggle / xterm Shift+(Cmd|Ctrl)+Enter passthrough
//
// shouldSkipXtermKey 命中条件:
//   keydown + Enter + Shift + (Meta || Ctrl) + !Alt + !isComposing
// 命中后 customKeyEventHandler return false → xterm 不发 \r 到 PTY,
// document keydown bubble 到 useCommandHotkeys 派发 terminal.zoom.toggle。

import { describe, it, expect } from 'vitest';
import { shouldSkipXtermKey } from '@/panels/Terminal/key-mapping';

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
