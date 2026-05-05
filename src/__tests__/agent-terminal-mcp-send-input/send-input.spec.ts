// BDD: agent-terminal-mcp-send-input

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_TOOL_SEND_INPUT,
  sendInputInputSchema,
  sendInputOutputSchema,
} from '../../../electron/shared/mcp-terminal-schemas';
import { makeSendInputTool } from '../../../electron/main/services/mcp-tools-terminal';

// ────────────────────────────────────────────────────────────
// 常量 + Schema
// ────────────────────────────────────────────────────────────

describe('MCP_TOOL_SEND_INPUT', () => {
  it('字符串契约', () => {
    expect(MCP_TOOL_SEND_INPUT).toBe('terminal.send_input');
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

const makeDeps = (overrides?: { has?: HasFn; write?: WriteFn }) => ({
  has: overrides?.has ?? vi.fn<HasFn>(() => true),
  write: overrides?.write ?? vi.fn<WriteFn>(() => true),
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
    const tool = makeSendInputTool({ has, write });
    await expect(
      tool.run({ session_id: 'nope', data: 'x' }),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
    expect(write).not.toHaveBeenCalled();
  });

  it('has=true + write 成功 → 返回 {}', async () => {
    const has = vi.fn<HasFn>(() => true);
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool({ has, write });
    const r = await tool.run({ session_id: 'term-1', data: 'ls\n' });
    expect(r).toEqual({});
    expect(write).toHaveBeenCalledWith('term-1', 'ls\n');
  });

  it('write 返回 false → 抛 TERMINAL_SESSION_NOT_FOUND', async () => {
    const has = vi.fn<HasFn>(() => true);
    const write = vi.fn<WriteFn>(() => false);
    const tool = makeSendInputTool({ has, write });
    await expect(
      tool.run({ session_id: 'term-1', data: 'x' }),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
  });

  it('data 透传(含控制字符)', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendInputTool(makeDeps({ write }));
    await tool.run({ session_id: 't', data: '\x03' });
    expect(write).toHaveBeenCalledWith('t', '\x03');
  });

  it('输出符合 sendInputOutputSchema', async () => {
    const tool = makeSendInputTool(makeDeps());
    const out = await tool.run({ session_id: 't', data: 'x' });
    expect(sendInputOutputSchema.safeParse(out).success).toBe(true);
  });
});
