// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mapTerminalKey } from '../../panels/Terminal/key-mapping';

interface KeyOpts {
  key: string;
  type?: 'keydown' | 'keyup' | 'keypress';
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

function ev(opts: KeyOpts): KeyboardEvent {
  return new KeyboardEvent(opts.type ?? 'keydown', {
    key: opts.key,
    shiftKey: opts.shiftKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
  });
}

describe('mapTerminalKey — Shift+Enter 多行输入(#18)', () => {
  it('Shift+Enter (keydown) → ESC+CR(\\x1b\\r)', () => {
    expect(mapTerminalKey(ev({ key: 'Enter', shiftKey: true }))).toBe(
      '\x1b\r',
    );
  });

  it('普通 Enter → null(走 xterm 默认 \\r)', () => {
    expect(mapTerminalKey(ev({ key: 'Enter' }))).toBeNull();
  });

  it('Shift+Enter keyup → null(只拦 keydown,避免重复发)', () => {
    expect(
      mapTerminalKey(ev({ key: 'Enter', type: 'keyup', shiftKey: true })),
    ).toBeNull();
  });

  it('Ctrl+Shift+Enter → null(拒绝复合修饰)', () => {
    expect(
      mapTerminalKey(ev({ key: 'Enter', shiftKey: true, ctrlKey: true })),
    ).toBeNull();
  });

  it('Meta+Shift+Enter → null', () => {
    expect(
      mapTerminalKey(ev({ key: 'Enter', shiftKey: true, metaKey: true })),
    ).toBeNull();
  });

  it('Alt+Shift+Enter → null', () => {
    expect(
      mapTerminalKey(ev({ key: 'Enter', shiftKey: true, altKey: true })),
    ).toBeNull();
  });

  it('Shift + 其他键(如 a) → null', () => {
    expect(mapTerminalKey(ev({ key: 'a', shiftKey: true }))).toBeNull();
  });

  it('单独 Shift → null', () => {
    expect(mapTerminalKey(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
  });
});
