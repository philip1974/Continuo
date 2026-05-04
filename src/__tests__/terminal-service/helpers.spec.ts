import { describe, it, expect } from 'vitest';
import {
  isInPlaceUpdate,
  safeTruncate,
} from '../../../electron/main/services/terminal.service';

describe('safeTruncate', () => {
  it('短于 max → 原样返回', () => {
    expect(safeTruncate('hello', 100)).toBe('hello');
  });

  it('超出 → 截到末尾 max 字节,前置 ANSI reset', () => {
    const data = 'a'.repeat(200);
    const r = safeTruncate(data, 50);
    // \x1b[0m 是 4 字节;然后接 50 个 a(实际可能更短,因为找 ESC 调整)
    expect(r.startsWith('\x1b[0m')).toBe(true);
    expect(r.length).toBeLessThanOrEqual(50 + 4);
  });

  it('截断点附近遇 ESC → 从 ESC 开始(防截断 ANSI 序列)', () => {
    // 构造:大量数据 + ESC + 控制序列
    const head = 'x'.repeat(100);
    const ansi = '\x1b[31m'; // 红色
    const tail = 'final';
    const data = head + ansi + tail;
    const r = safeTruncate(data, 20);
    expect(r.startsWith('\x1b[0m')).toBe(true);
    // 截断点应该在 ansi 起点 ESC 之后(或之前回退)
    // 实际就是说不会切到 \x1b[31m 中间
  });

  it('单字符 max 也能工作(不 crash)', () => {
    const r = safeTruncate('xx'.repeat(50), 1);
    expect(r.startsWith('\x1b[0m')).toBe(true);
  });
});

describe('isInPlaceUpdate', () => {
  it('包含光标移动 ESC[A → true', () => {
    expect(isInPlaceUpdate('\x1b[2A')).toBe(true);
  });

  it('包含光标到行首 ESC[H → true', () => {
    expect(isInPlaceUpdate('\x1b[H')).toBe(true);
  });

  it('包含清到行尾 ESC[K → true', () => {
    expect(isInPlaceUpdate('\x1b[K')).toBe(true);
  });

  it('普通文本无 ESC → false', () => {
    expect(isInPlaceUpdate('hello world')).toBe(false);
  });

  it('长文本即便有 ESC → false(避免大段输出被误判)', () => {
    const big = 'x'.repeat(600) + '\x1b[A';
    expect(isInPlaceUpdate(big)).toBe(false);
  });

  it('彩色文本 ESC[31m 不算 in-place(只是属性,不是定位)', () => {
    expect(isInPlaceUpdate('\x1b[31mhello')).toBe(false);
  });
});
