// BDD: agent-terminal-mcp-send-text

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_TOOL_SEND_TEXT,
  sendTextInputSchema,
  sendTextOutputSchema,
} from '../../../electron/shared/mcp-terminal-schemas';
import { makeSendTextTool } from '../../../electron/main/services/mcp-tools-terminal';

describe('MCP_TOOL_SEND_TEXT', () => {
  it('字符串契约', () => {
    expect(MCP_TOOL_SEND_TEXT).toBe('terminal.send_text');
  });
});

describe('sendTextInputSchema', () => {
  it('全字段 → ok', () => {
    expect(
      sendTextInputSchema.safeParse({ session_id: 'a', text: 'hello' }).success,
    ).toBe(true);
  });

  it('text 空字符串 → ok(显式允许)', () => {
    expect(
      sendTextInputSchema.safeParse({ session_id: 'a', text: '' }).success,
    ).toBe(true);
  });

  it('text 超 2M 字符 → fail', () => {
    const big = 'x'.repeat(2_000_001);
    expect(
      sendTextInputSchema.safeParse({ session_id: 'a', text: big }).success,
    ).toBe(false);
  });

  it('缺 session_id → fail', () => {
    expect(
      sendTextInputSchema.safeParse({ text: 'hi' }).success,
    ).toBe(false);
  });

  it('缺 text → fail', () => {
    expect(
      sendTextInputSchema.safeParse({ session_id: 'a' }).success,
    ).toBe(false);
  });

  it('未知字段 → fail(strict)', () => {
    expect(
      sendTextInputSchema.safeParse({
        session_id: 'a',
        text: 'b',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('sendTextOutputSchema', () => {
  it('空对象 → ok', () => {
    expect(sendTextOutputSchema.safeParse({}).success).toBe(true);
  });

  it('额外字段 → fail', () => {
    expect(sendTextOutputSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// makeSendTextTool · 行为
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

describe('makeSendTextTool · 元数据', () => {
  it('name 与契约常量一致', () => {
    const tool = makeSendTextTool(makeDeps());
    expect(tool.name).toBe(MCP_TOOL_SEND_TEXT);
  });

  // 边界(E203):inputSchema 是 session_id 加 .max(SESSION_ID_MAX) 的 bounded schema(协议原 schema 无上限)。
  it('E203 inputSchema 对 session_id 加长度上限(超 256 → 拒)', () => {
    const tool = makeSendTextTool(makeDeps());
    const longId = 'term-' + 'x'.repeat(300);
    expect(
      tool.inputSchema.safeParse({ session_id: longId, text: 'hi' }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ session_id: 'term-1', text: 'hi' }).success,
    ).toBe(true);
    expect(
      sendTextInputSchema.safeParse({ session_id: longId, text: 'hi' }).success,
    ).toBe(true);
    // 边界(E204):公开 jsonSchema 同步声明 maxLength:256(advertised↔运行时一致)。
    expect(JSON.stringify(tool.jsonSchema)).toContain('"maxLength":256');
  });

  // 边界(E220,E219 兄弟,字节 vs code-unit):text 按真实 UTF-8 字节限,非协议的 .max()(code unit)。
  it('E220 inputSchema 对 text 加真实字节上限(CJK byteLength>2M,length≤2M → 拒)', () => {
    const tool = makeSendTextTool(makeDeps());
    const cjk = '中'.repeat(700_000);
    expect(
      tool.inputSchema.safeParse({ session_id: 'term-1', text: cjk }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ session_id: 'term-1', text: 'hi' }).success,
    ).toBe(true);
    expect(
      sendTextInputSchema.safeParse({ session_id: 'term-1', text: cjk }).success,
    ).toBe(true);
  });
});

describe('makeSendTextTool · run', () => {
  it('has=false → 抛 TERMINAL_SESSION_NOT_FOUND', async () => {
    const has = vi.fn<HasFn>(() => false);
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendTextTool(makeDeps({ has, write }));
    await expect(
      tool.run({ session_id: 'nope', text: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
    expect(write).not.toHaveBeenCalled();
  });

  it('has=true + write 成功 → write 被调,text 逐字写入,返回 {}', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendTextTool(makeDeps({ write }));
    const r = await tool.run({ session_id: 'term-1', text: '你好' }, ctx);
    expect(r).toEqual({});
    expect(write).toHaveBeenCalledWith('term-1', '你好');
  });

  it('text 不变换 — 含 \\n 也直接写入,不转 \\r', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendTextTool(makeDeps({ write }));
    await tool.run({ session_id: 't', text: 'line1\nline2' }, ctx);
    expect(write).toHaveBeenCalledWith('t', 'line1\nline2');
  });

  it('text 不追加 \\r — server 不替 LLM 决定按 Enter', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendTextTool(makeDeps({ write }));
    await tool.run({ session_id: 't', text: 'hello' }, ctx);
    expect(write).toHaveBeenCalledWith('t', 'hello');
    // 注意:不是 'hello\r' 也不是 'hello\n'
  });

  it('write 返回 false → 抛 TERMINAL_SESSION_NOT_FOUND', async () => {
    const write = vi.fn<WriteFn>(() => false);
    const tool = makeSendTextTool(makeDeps({ write }));
    await expect(
      tool.run({ session_id: 'term-1', text: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
  });

  it('text 空字符串 → 仍调 write(空),返回 {}', async () => {
    const write = vi.fn<WriteFn>(() => true);
    const tool = makeSendTextTool(makeDeps({ write }));
    const r = await tool.run({ session_id: 't', text: '' }, ctx);
    expect(r).toEqual({});
    expect(write).toHaveBeenCalledWith('t', '');
  });

  it('输出符合 sendTextOutputSchema', async () => {
    const tool = makeSendTextTool(makeDeps());
    const out = await tool.run({ session_id: 't', text: 'x' }, ctx);
    expect(sendTextOutputSchema.safeParse(out).success).toBe(true);
  });
});
