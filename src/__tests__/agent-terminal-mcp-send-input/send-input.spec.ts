// BDD: agent-terminal-mcp-send-input

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_TOOL_SEND_INPUT,
  sendInputInputSchema,
  sendInputOutputSchema,
} from '../../../electron/shared/mcp-terminal-schemas';
import {
  makeSendInputTool,
  preparePtyData,
} from '../../../electron/main/services/mcp-tools-terminal';

// ────────────────────────────────────────────────────────────
// 常量 + Schema
// ────────────────────────────────────────────────────────────

describe('MCP_TOOL_SEND_INPUT', () => {
  it('字符串契约', () => {
    expect(MCP_TOOL_SEND_INPUT).toBe('terminal.send_input');
  });
});

// ────────────────────────────────────────────────────────────
// preparePtyData(纯函数)
// ────────────────────────────────────────────────────────────

describe('preparePtyData', () => {
  it('普通文本不变', () => {
    expect(preparePtyData('hello')).toBe('hello');
  });

  it('真 \\n → \\r(raw mode TUI 期望 CR;cooked mode termios ICRNL 处理)', () => {
    expect(preparePtyData('ls\n')).toBe('ls\r');
  });

  it('真 \\r 保留', () => {
    expect(preparePtyData('ls\r')).toBe('ls\r');
  });

  it('字面 "\\\\n" 双字符 → 真 \\n → \\r', () => {
    expect(preparePtyData('ls\\n')).toBe('ls\r');
  });

  it('字面 "\\\\r" 双字符 → 真 \\r', () => {
    expect(preparePtyData('ls\\r')).toBe('ls\r');
  });

  it('字面 "\\\\t" 双字符 → 真 tab', () => {
    expect(preparePtyData('a\\tb')).toBe('a\tb');
  });

  it('字面 "\\\\x03" 四字符 → 0x03 单字节(Ctrl+C)', () => {
    expect(preparePtyData('\\x03')).toBe('\x03');
  });

  it('字面 "\\\\x1b" → 真 ESC', () => {
    expect(preparePtyData('\\x1b')).toBe('\x1b');
  });

  it('真控制字符 \\x03 不变', () => {
    expect(preparePtyData('\x03')).toBe('\x03');
  });

  it('多行 \\n 全转 \\r', () => {
    expect(preparePtyData('a\nb\nc')).toBe('a\rb\rc');
  });

  it('混合:文字 + 字面 \\n + 真 \\n + Ctrl+C', () => {
    expect(preparePtyData('hi\\n\nworld\\x03')).toBe('hi\r\rworld\x03');
  });
});

describe('sendInputInputSchema', () => {
  it('全字段 → ok', () => {
    expect(
      sendInputInputSchema.safeParse({ session_id: 'term-1', data: 'ls\n' })
        .success,
    ).toBe(true);
  });

  it('Ctrl+C(\\x03) 接受', () => {
    expect(
      sendInputInputSchema.safeParse({ session_id: 'a', data: '\x03' }).success,
    ).toBe(true);
  });

  it('缺 session_id → fail', () => {
    expect(
      sendInputInputSchema.safeParse({ data: 'hi' }).success,
    ).toBe(false);
  });

  it('session_id 空字符串 → fail', () => {
    expect(
      sendInputInputSchema.safeParse({ session_id: '', data: 'hi' }).success,
    ).toBe(false);
  });

  it('data 超 2M 字符 → fail', () => {
    const big = 'x'.repeat(2_000_001);
    expect(
      sendInputInputSchema.safeParse({ session_id: 'a', data: big }).success,
    ).toBe(false);
  });

  it('未知字段 → fail(strict)', () => {
    expect(
      sendInputInputSchema.safeParse({
        session_id: 'a',
        data: 'b',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('sendInputOutputSchema', () => {
  it('空对象 → ok', () => {
    expect(sendInputOutputSchema.safeParse({}).success).toBe(true);
  });

  it('额外字段 → fail(strict)', () => {
    expect(
      sendInputOutputSchema.safeParse({ ok: true }).success,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// makeSendInputTool · 行为
// ────────────────────────────────────────────────────────────

type HasFn = (id: string) => boolean;
type WriteFn = (id: string, data: string) => boolean;
type GetSessionOwnerFn = (id: string) => number | null;
const ctx = { ownerWindowId: 1 };

const makeDeps = (overrides?: {
  has?: HasFn;
  write?: WriteFn;
  getSessionOwner?: GetSessionOwnerFn;
}) => ({
  has: overrides?.has ?? vi.fn<HasFn>(() => true),
  write: overrides?.write ?? vi.fn<WriteFn>(() => true),
  getSessionOwner:
    overrides?.getSessionOwner ?? vi.fn<GetSessionOwnerFn>(() => 1),
});

describe('makeSendInputTool · 元数据', () => {
  it('name 与契约常量一致', () => {
    const tool = makeSendInputTool(makeDeps());
    expect(tool.name).toBe(MCP_TOOL_SEND_INPUT);
  });

  it('inputSchema 是 sendInputInputSchema', () => {
    const tool = makeSendInputTool(makeDeps());
    expect(tool.inputSchema).toBe(sendInputInputSchema);
  });
});

describe('makeSendInputTool · run', () => {
  it('has=false → 抛 TERMINAL_SESSION_NOT_FOUND', async () => {
    const has = vi.fn<HasFn>(() => false);
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool(makeDeps({ has, write }));
    await expect(
      tool.run({ session_id: 'nope', data: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
    expect(write).not.toHaveBeenCalled();
  });

  it('has=true + write 成功 → 返回 {}(经 preparePtyData 处理 \\n→\\r)', async () => {
    const has = vi.fn<HasFn>(() => true);
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool(makeDeps({ has, write }));
    const r = await tool.run({ session_id: 'term-1', data: 'ls\n' }, ctx);
    expect(r).toEqual({});
    // preparePtyData:\n → \r(为兼容 raw mode TUI Enter)
    expect(write).toHaveBeenCalledWith('term-1', 'ls\r');
  });

  it('write 返回 false → 抛 TERMINAL_SESSION_NOT_FOUND', async () => {
    const has = vi.fn<HasFn>(() => true);
    const write = vi.fn<WriteFn>(() => false);
    const tool = makeSendInputTool(makeDeps({ has, write }));
    await expect(
      tool.run({ session_id: 'term-1', data: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
  });

  it('Ctrl+C(\\x03) 透传(LF→CR 不影响,无字面 escape)', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool(makeDeps({ write }));
    await tool.run({ session_id: 't', data: '\x03' }, ctx);
    expect(write).toHaveBeenCalledWith('t', '\x03');
  });

  it('原始 \\r 保留(已是 CR,不动)', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool(makeDeps({ write }));
    await tool.run({ session_id: 't', data: 'ls\r' }, ctx);
    expect(write).toHaveBeenCalledWith('t', 'ls\r');
  });

  it('字面 "\\\\n" 双字符 → 真换行 → 转 \\r(LLM 容错)', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool(makeDeps({ write }));
    await tool.run({ session_id: 't', data: 'ls\\n' }, ctx);
    expect(write).toHaveBeenCalledWith('t', 'ls\r');
  });

  it('字面 "\\\\x03" 四字符 → 0x03 单字节(LLM 容错)', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool(makeDeps({ write }));
    await tool.run({ session_id: 't', data: '\\x03' }, ctx);
    expect(write).toHaveBeenCalledWith('t', '\x03');
  });

  it('多行 \\n → 多 \\r', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool(makeDeps({ write }));
    await tool.run({ session_id: 't', data: 'a\nb\nc' }, ctx);
    expect(write).toHaveBeenCalledWith('t', 'a\rb\rc');
  });

  it('输出符合 sendInputOutputSchema', async () => {
    const tool = makeSendInputTool(makeDeps());
    const out = await tool.run({ session_id: 't', data: 'x' }, ctx);
    expect(sendInputOutputSchema.safeParse(out).success).toBe(true);
  });
});
