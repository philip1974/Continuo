// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  applyMappedKeyOnKeydown,
  consumeMappedKeyOnData,
  createMappedKeyState,
  mapTerminalKey,
} from '../../panels/Terminal/key-mapping';

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

  it('IME 组合态 Shift+Enter → null(不破坏中日韩输入法)', () => {
    // jsdom 的 KeyboardEvent 默认 isComposing=false,需用 new Event 模拟
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
    });
    Object.defineProperty(event, 'isComposing', { get: () => true });
    expect(mapTerminalKey(event)).toBeNull();
  });
});

describe('xterm 集成层 — handler→PTY 字节映射(#18,字节级保证 ≠ 端到端)', () => {
  it('Shift+Enter 双写修复:keydown 设 pending → onData 替换 \\r 为 \\x1b\\r', () => {
    const state = createMappedKeyState();
    const writes: string[] = [];
    const fakeWrite = (data: string): void => {
      writes.push(data);
    };

    // 用户按 Shift+Enter — keydown 入口
    applyMappedKeyOnKeydown(state, ev({ key: 'Enter', shiftKey: true }));
    expect(state.pending).toBe('\x1b\r');

    // xterm 内部对 Enter 默认发 \r 到 onData — 我们替换为 \x1b\r
    const outgoing = consumeMappedKeyOnData(state, '\r');
    fakeWrite(outgoing);

    expect(writes).toEqual(['\x1b\r']); // ← 只写一次,不含尾部 \r
    expect(state.pending).toBeNull(); // ← pending 已消费
  });

  it('普通 Enter:无 pending,\\r 原样透传', () => {
    const state = createMappedKeyState();
    const writes: string[] = [];
    const fakeWrite = (data: string): void => {
      writes.push(data);
    };

    applyMappedKeyOnKeydown(state, ev({ key: 'Enter' }));
    expect(state.pending).toBeNull();

    fakeWrite(consumeMappedKeyOnData(state, '\r'));
    expect(writes).toEqual(['\r']);
  });

  it('Shift+Enter 后紧跟普通字符:替换只生效一次', () => {
    const state = createMappedKeyState();
    const writes: string[] = [];
    const fakeWrite = (data: string): void => {
      writes.push(data);
    };

    applyMappedKeyOnKeydown(state, ev({ key: 'Enter', shiftKey: true }));
    fakeWrite(consumeMappedKeyOnData(state, '\r')); // → \x1b\r
    fakeWrite(consumeMappedKeyOnData(state, 'a')); // → 'a'(无 pending)

    expect(writes).toEqual(['\x1b\r', 'a']);
  });
});
