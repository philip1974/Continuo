// BDD: agent-terminal-mcp-stdio-framing
// NDJSON 行切分纯函数。

import { describe, it, expect } from 'vitest';
import {
  resolveStdioHelloWindowId,
  splitLines,
  type FramingState,
} from '../../../electron/main/services/mcp-stdio-server.service';

const empty: FramingState = { buf: '' };

describe('splitLines · 基础', () => {
  it('空 chunk → 状态不变,lines 空', () => {
    const r = splitLines(empty, '');
    expect(r.state.buf).toBe('');
    expect(r.lines).toEqual([]);
  });

  it('单行带 \\n → 一行 lines,buf 清空', () => {
    const r = splitLines(empty, 'hello\n');
    expect(r.state.buf).toBe('');
    expect(r.lines).toEqual(['hello']);
  });

  it('多行 → 顺序保留', () => {
    const r = splitLines(empty, 'a\nb\nc\n');
    expect(r.state.buf).toBe('');
    expect(r.lines).toEqual(['a', 'b', 'c']);
  });

  it('chunk 不含 \\n → 全留 buf', () => {
    const r = splitLines(empty, 'partial');
    expect(r.state.buf).toBe('partial');
    expect(r.lines).toEqual([]);
  });

  it('chunk 末尾无 \\n → 残行入 buf', () => {
    const r = splitLines(empty, 'a\nbar');
    expect(r.state.buf).toBe('bar');
    expect(r.lines).toEqual(['a']);
  });
});

describe('splitLines · 跨 chunk', () => {
  it('一行被切成两 chunk → 第二次调拼接', () => {
    const r1 = splitLines(empty, '{"a":');
    expect(r1.lines).toEqual([]);
    expect(r1.state.buf).toBe('{"a":');
    const r2 = splitLines(r1.state, '1}\n');
    expect(r2.state.buf).toBe('');
    expect(r2.lines).toEqual(['{"a":1}']);
  });

  it('三 chunk 拼一行', () => {
    const r1 = splitLines(empty, 'aaa');
    const r2 = splitLines(r1.state, 'bbb');
    const r3 = splitLines(r2.state, 'ccc\n');
    expect(r3.state.buf).toBe('');
    expect(r3.lines).toEqual(['aaabbbccc']);
  });

  it('chunk 含完整行 + 残行', () => {
    const r1 = splitLines(empty, 'first\nsecond-par');
    expect(r1.lines).toEqual(['first']);
    expect(r1.state.buf).toBe('second-par');
    const r2 = splitLines(r1.state, 'tial\nthird\n');
    expect(r2.state.buf).toBe('');
    expect(r2.lines).toEqual(['second-partial', 'third']);
  });
});

describe('splitLines · 空行 / 边界', () => {
  it('连续 \\n → 中间空字符串保留', () => {
    const r = splitLines(empty, 'a\n\nb\n');
    expect(r.lines).toEqual(['a', '', 'b']);
  });

  it('开头就是 \\n → 第一个 line 是空字符串', () => {
    const r = splitLines(empty, '\nhello\n');
    expect(r.lines).toEqual(['', 'hello']);
  });

  it('CRLF — \\r 当普通字符保留(NDJSON 要求 LF)', () => {
    const r = splitLines(empty, 'a\r\nb\r\n');
    // \r 留在 line 末尾,NDJSON parser 应容忍(JSON.parse 接受额外 whitespace)
    expect(r.lines).toEqual(['a\r', 'b\r']);
  });

  it('chunk 仅一个 \\n → 一个空 line', () => {
    const r = splitLines(empty, '\n');
    expect(r.lines).toEqual(['']);
    expect(r.state.buf).toBe('');
  });
});

describe('splitLines · 不变量', () => {
  it('返回新 state,不 mutate 入参', () => {
    const before = { buf: 'persist' };
    splitLines(before, 'x\n');
    // before 仍是初始值
    expect(before.buf).toBe('persist');
  });

  it('lines 是数组(可空)', () => {
    expect(Array.isArray(splitLines(empty, '').lines)).toBe(true);
    expect(Array.isArray(splitLines(empty, 'a\n').lines)).toBe(true);
  });
});

describe('_continuo/hello · window token', () => {
  it('windowId 与 token 解析出的 owner 一致 → 返回 windowId', () => {
    const r = resolveStdioHelloWindowId(
      { windowId: 11, token: 'tok-a' },
      {
        resolveWindowId: (token) => (token === 'tok-a' ? 11 : null),
        windowExists: (windowId) => windowId === 11,
      },
    );
    expect(r).toBe(11);
  });

  it('缺 token 或 token 不属于该 window → 拒绝绑定', () => {
    const deps = {
      resolveWindowId: (token: string) => (token === 'tok-a' ? 11 : null),
      windowExists: () => true,
    };

    expect(resolveStdioHelloWindowId({ windowId: 11 }, deps)).toBeNull();
    expect(
      resolveStdioHelloWindowId({ windowId: 22, token: 'tok-a' }, deps),
    ).toBeNull();
    expect(
      resolveStdioHelloWindowId({ windowId: 11, token: 'unknown' }, deps),
    ).toBeNull();
  });

  it('token 有效但窗口不存在 → 拒绝绑定', () => {
    const r = resolveStdioHelloWindowId(
      { windowId: 11, token: 'tok-a' },
      {
        resolveWindowId: () => 11,
        windowExists: () => false,
      },
    );
    expect(r).toBeNull();
  });
});
