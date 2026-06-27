// BDD: agent-terminal-mcp-stdio-framing
// NDJSON 行切分纯函数。

import { describe, it, expect, vi } from 'vitest';
import { splitLines as splitNdjsonLines } from '@continuo-terminal/server-node';
import {
  hasOversizedStdioLine,
  resolveStdioHelloWindowId,
} from '../../../electron/main/services/mcp-stdio-server.service';

interface FramingState {
  readonly buf: string;
}

function splitLines(state: FramingState, chunk: string) {
  const r = splitNdjsonLines(state.buf, chunk);
  return { state: { buf: r.buffer }, lines: r.lines };
}

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

  it('CRLF — SDK stdio framing strips trailing \\r', () => {
    const r = splitLines(empty, 'a\r\nb\r\n');
    // CT-B3: CRLF stripped per SDK serializeMessage/deserializeMessage parity.
    // JSON-RPC stdio framing tolerates CRLF; payload itself never contains CR.
    // Pre-CT-B3 CR-retention was an accidental legacy detail (not a feature) —
    // SDK behavior is the intended semantics.
    expect(r.lines).toEqual(['a', 'b']);
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

  // 边界(E252):windowId 须安全非负整数(对齐 AttachTargetSchema.windowId)。负数/不安全整数/小数/
  // 非有限值即便 token 匹配也拒,防精度碰撞/误探窗口。
  it('E252 windowId 非安全非负整数(负/不安全/小数/NaN/Infinity)→ 拒绝绑定', () => {
    const deps = {
      // resolveWindowId 故意回传与传入相同的 windowId(若不挡形态就会通过 ===)
      resolveWindowId: () => -1,
      windowExists: () => true,
    };
    for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        resolveStdioHelloWindowId({ windowId: bad, token: 'tok-a' }, {
          resolveWindowId: () => bad as number,
          windowExists: () => true,
        }),
      ).toBeNull();
    }
    // 引用 deps 避免未使用告警(语义同上)
    expect(resolveStdioHelloWindowId({ windowId: -1, token: 't' }, deps)).toBeNull();
  });

  // 边界(E297,E252 同一 stdio hello payload 兄弟字段):token 超长(合法 host token 43 字符)→ 拒绝绑定,
  // 不进 resolveWindowId(防 1MB token 经 Map.get/比较放大)。
  it('E297 超长 token(> 256)→ 拒绝绑定,resolveWindowId 不被调用', () => {
    let called = false;
    const r = resolveStdioHelloWindowId(
      { windowId: 11, token: 'x'.repeat(257) },
      {
        resolveWindowId: () => {
          called = true;
          return 11;
        },
        windowExists: () => true,
      },
    );
    // neutralize 敏感:去 token 长度上限则进 resolveWindowId(called=true)且返回 11。
    expect(r).toBeNull();
    expect(called).toBe(false);
  });
});

describe('stdio line size guard', () => {
  it('完整行字节上限检查单趟扫描,不调用 lines.some', () => {
    const lines = ['ok', '中'.repeat(40)];
    const someSpy = vi.spyOn(lines, 'some');

    try {
      expect(hasOversizedStdioLine(lines, 100)).toBe(true);
      expect(hasOversizedStdioLine(['ok', 'still ok'], 100)).toBe(false);
      expect(someSpy).not.toHaveBeenCalled();
    } finally {
      someSpy.mockRestore();
    }
  });
});
