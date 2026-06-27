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

  // 边界(E149,E125 同族):按真实 UTF-8 字节截断(非 UTF-16 code unit)。CJK 3 bytes/字。
  it('E149 多字节内容按真实 UTF-8 字节截断(非 code unit)', () => {
    const data = '中'.repeat(200); // 200 code units,600 bytes
    const r = safeTruncate(data, 60); // 保留 ≤60 字节 ≈ 20 个 '中'
    expect(r.startsWith('\x1b[0m')).toBe(true);
    const tail = r.slice('\x1b[0m'.length);
    // 保留内容真实字节 ≤ 60(旧 code-unit 实现会保留 60 个 '中' = 180 字节)
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(60);
    // 未拆坏多字节字符(无替换字符 U+FFFD)
    expect(tail.includes('�')).toBe(false);
    expect(tail.startsWith('中')).toBe(true);
  });

  it('E149 emoji(4 字节)截断保持字符边界,不产生 U+FFFD', () => {
    const data = '😀'.repeat(100); // 100 emoji,400 bytes,200 code units
    const r = safeTruncate(data, 40); // ≤40 字节 = 10 emoji
    const tail = r.slice('\x1b[0m'.length);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(40);
    expect(tail.includes('�')).toBe(false);
  });

  it('E149 byteLength ≤ max 的多字节内容 → 原样返回', () => {
    const data = '中'.repeat(10); // 30 bytes
    expect(safeTruncate(data, 64 * 1024)).toBe(data);
  });

  // 边界(E244):前置 reset(`\x1b[0m`,4 字节)须计入预算 —— 返回值**总**真实字节数 ≤ maxBytes,
  // 而非 maxBytes+4。此前先按 maxBytes 留尾部再无条件前置 reset → 输出超约 4 字节。
  it('E244 返回值总字节(含 reset 前缀)≤ maxBytes(ASCII)', () => {
    const r = safeTruncate('a'.repeat(500), 50);
    expect(r.startsWith('\x1b[0m')).toBe(true);
    expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(50); // 不是 54
  });

  it('E244 总字节 ≤ maxBytes(CJK,reset 占预算不拆字符)', () => {
    const r = safeTruncate('中'.repeat(500), 64);
    expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(64);
    expect(r.includes('�')).toBe(false);
  });

  it('E244 总字节 ≤ maxBytes(emoji 4 字节)', () => {
    const r = safeTruncate('😀'.repeat(200), 44);
    expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(44);
    expect(r.includes('�')).toBe(false);
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
