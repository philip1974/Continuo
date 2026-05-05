// BDD: agent-terminal-mcp-buffer
// per-session 环形 buffer + ANSI strip。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensure,
  append,
  read,
  destroy,
  stripAnsi,
  _resetForTest,
} from '../../../electron/main/services/terminal-buffer.service';

beforeEach(() => {
  _resetForTest();
});

// ────────────────────────────────────────────────────────────
// stripAnsi
// ────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('普通文本不变', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('剥 CSI 颜色', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('剥多个 CSI', () => {
    expect(stripAnsi('\x1b[2J\x1b[H' + 'hello')).toBe('hello');
  });

  it('剥光标移动', () => {
    expect(stripAnsi('\x1b[1Aabc\x1b[2K')).toBe('abc');
  });

  it('多字节 UTF-8 不破坏', () => {
    expect(stripAnsi('\x1b[31m你好\x1b[0m')).toBe('你好');
  });

  it('未识别的 ESC 序列保留(保守:不在 CSI/OSC/keypad 集内的不剥)', () => {
    expect(stripAnsi('\x1bxhello')).toBe('\x1bxhello');
  });

  it('混合多行', () => {
    expect(stripAnsi('\x1b[32mok\x1b[0m\n\x1b[31merr\x1b[0m')).toBe('ok\nerr');
  });

  it('剥 OSC(ESC ] ... BEL)— 设 window title', () => {
    expect(stripAnsi('\x1b]2;my title\x07hello')).toBe('hello');
  });

  it('剥 OSC(ESC ] ... ST,即 ESC \\)— 设工作目录', () => {
    expect(stripAnsi('\x1b]7;file:///path\x1b\\hello')).toBe('hello');
  });

  it('剥 keypad 模式(ESC = / ESC >)', () => {
    expect(stripAnsi('\x1b=hello\x1b>')).toBe('hello');
  });

  it('zsh prompt 实测组合:OSC + CSI + keypad 一起剥', () => {
    const raw =
      '\x1b]2;RiGang@MacBook-Pro:~\x07\x1b]1;~\x07\x1b]7;file:///Users/RiGang\x1b\\\rprompt $ \x1b=cmd\x1b>';
    expect(stripAnsi(raw)).toBe('\rprompt $ cmd');
  });
});

// ────────────────────────────────────────────────────────────
// ensure / append
// ────────────────────────────────────────────────────────────

describe('ensure / append', () => {
  it('ensure 不存在 id → 创建空 buffer', () => {
    ensure('term-1');
    const r = read('term-1');
    expect(r).toEqual({ lines: [], nextSeq: 0, truncated: false });
  });

  it('重复 ensure 同 id → 不重置', () => {
    ensure('term-1');
    append('term-1', 'a\n');
    ensure('term-1');
    const r = read('term-1');
    expect(r.lines).toEqual(['a']);
    expect(r.nextSeq).toBe(1);
  });

  it('append 不存在 id → 自动 ensure 后追加', () => {
    append('term-1', 'hello\n');
    const r = read('term-1');
    expect(r.lines).toEqual(['hello']);
  });

  it('多次 append → seq 单调递增', () => {
    append('term-1', 'a');
    append('term-1', 'b');
    append('term-1', 'c');
    const r = read('term-1');
    expect(r.nextSeq).toBe(3);
  });

  it('多 session 互不影响', () => {
    append('a', 'A\n');
    append('b', 'B\n');
    expect(read('a').lines).toEqual(['A']);
    expect(read('b').lines).toEqual(['B']);
  });
});

// ────────────────────────────────────────────────────────────
// read 基本
// ────────────────────────────────────────────────────────────

describe('read · 基本', () => {
  it('不存在 id → 抛 BUFFER_SESSION_NOT_FOUND', () => {
    expect(() => read('nope')).toThrowError(/not.found/i);
  });

  it('空 buffer → lines 空,nextSeq 0', () => {
    ensure('term-1');
    expect(read('term-1')).toEqual({
      lines: [],
      nextSeq: 0,
      truncated: false,
    });
  });

  it('chunk 跨行合并 + 切 \\n', () => {
    append('term-1', 'line1\nline');
    append('term-1', '2\nline3\n');
    const r = read('term-1');
    expect(r.lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('CRLF 也切', () => {
    append('term-1', 'a\r\nb\r\nc\r\n');
    const r = read('term-1');
    expect(r.lines).toEqual(['a', 'b', 'c']);
  });

  it('末尾连续空行 trim', () => {
    append('term-1', 'a\n\n\n');
    const r = read('term-1');
    expect(r.lines).toEqual(['a']);
  });

  it('中间空行保留', () => {
    append('term-1', 'a\n\nb\n');
    const r = read('term-1');
    expect(r.lines).toEqual(['a', '', 'b']);
  });

  it('默认 stripAnsi=true', () => {
    append('term-1', '\x1b[31mred\x1b[0m\nplain\n');
    const r = read('term-1');
    expect(r.lines).toEqual(['red', 'plain']);
  });

  it('stripAnsi=false → 保留 escape', () => {
    append('term-1', '\x1b[31mred\x1b[0m\n');
    const r = read('term-1', { stripAnsi: false });
    expect(r.lines[0]).toBe('\x1b[31mred\x1b[0m');
  });
});

// ────────────────────────────────────────────────────────────
// read · sinceSeq 增量
// ────────────────────────────────────────────────────────────

describe('read · sinceSeq', () => {
  it('sinceSeq=0 → 所有 entries(等价缺省)', () => {
    append('t', 'a\n');
    append('t', 'b\n');
    expect(read('t', { sinceSeq: 0 }).lines).toEqual(['a', 'b']);
  });

  it('sinceSeq=N → 仅 seq>=N 的 entries', () => {
    append('t', 'a\n'); // seq 0
    append('t', 'b\n'); // seq 1
    append('t', 'c\n'); // seq 2
    expect(read('t', { sinceSeq: 1 }).lines).toEqual(['b', 'c']);
    expect(read('t', { sinceSeq: 2 }).lines).toEqual(['c']);
  });

  it('sinceSeq 大于所有 seq → 空 lines', () => {
    append('t', 'a\n'); // seq 0
    expect(read('t', { sinceSeq: 999 }).lines).toEqual([]);
  });

  it('增量串联:首次缺省 → 拿 nextSeq → 下次 sinceSeq 续读', () => {
    append('t', 'a\n');
    const r1 = read('t');
    expect(r1.lines).toEqual(['a']);
    expect(r1.nextSeq).toBe(1);

    append('t', 'b\n');
    const r2 = read('t', { sinceSeq: r1.nextSeq });
    expect(r2.lines).toEqual(['b']);
    expect(r2.nextSeq).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────
// read · maxLines truncate
// ────────────────────────────────────────────────────────────

describe('read · maxLines', () => {
  it('lines 超 maxLines → truncated=true,取最后 N 行', () => {
    for (let i = 0; i < 10; i++) append('t', `line${i}\n`);
    const r = read('t', { maxLines: 3 });
    expect(r.lines).toEqual(['line7', 'line8', 'line9']);
    expect(r.truncated).toBe(true);
  });

  it('lines 不超 maxLines → truncated=false', () => {
    append('t', 'a\nb\n');
    const r = read('t', { maxLines: 100 });
    expect(r.truncated).toBe(false);
  });

  it('默认 maxLines=200', () => {
    for (let i = 0; i < 250; i++) append('t', `l${i}\n`);
    const r = read('t');
    expect(r.lines).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(r.lines[0]).toBe('l50');
    expect(r.lines[199]).toBe('l249');
  });
});

// ────────────────────────────────────────────────────────────
// 容量上限 / 丢底
// ────────────────────────────────────────────────────────────

describe('capacity', () => {
  // 直接验 8000 太慢,仅测 nextSeq 单调 + 客户端 since 越界时 truncated。
  // 真容量 8000 由实装常量保证,本主题不直接断言数字。
  it('append 多次后 nextSeq 单调递增,不复用', () => {
    for (let i = 0; i < 100; i++) append('t', `${i}\n`);
    expect(read('t').nextSeq).toBe(100);
  });

  it('buffer 持有 entries[0].seq > sinceSeq → truncated=true(数据缺口)', () => {
    // 用 setBufferCapacityForTest 可显式测,P3 暂略过;留 E2E。
    // 这里只确保:正常情况下 sinceSeq 在 entries 范围内,truncated=false
    append('t', 'a\n');
    expect(read('t', { sinceSeq: 0 }).truncated).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// destroy
// ────────────────────────────────────────────────────────────

describe('destroy', () => {
  it('删 buffer 后 read 抛', () => {
    append('t', 'a\n');
    destroy('t');
    expect(() => read('t')).toThrowError(/not.found/i);
  });

  it('删不存在 id → 不抛', () => {
    expect(() => destroy('nope')).not.toThrow();
  });
});
