// BDD: agent-terminal-mcp-read-output

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_TOOL_READ_OUTPUT,
  readOutputInputSchema,
  readOutputOutputSchema,
} from '../../../electron/shared/mcp-terminal-schemas';
import { makeReadOutputTool } from '../../../electron/main/services/mcp-tools-terminal';

// ────────────────────────────────────────────────────────────
// 常量 + Schema
// ────────────────────────────────────────────────────────────

describe('MCP_TOOL_READ_OUTPUT', () => {
  it('字符串契约', () => {
    expect(MCP_TOOL_READ_OUTPUT).toBe('terminal.read_output');
  });
});

describe('readOutputInputSchema', () => {
  it('仅 session_id → ok', () => {
    expect(
      readOutputInputSchema.safeParse({ session_id: 'a' }).success,
    ).toBe(true);
  });

  it('全字段 → ok', () => {
    expect(
      readOutputInputSchema.safeParse({
        session_id: 'a',
        since_seq: 5,
        max_lines: 100,
        strip_ansi: false,
      }).success,
    ).toBe(true);
  });

  it('max_lines 超 2000 → fail', () => {
    expect(
      readOutputInputSchema.safeParse({ session_id: 'a', max_lines: 2001 })
        .success,
    ).toBe(false);
  });

  it('max_lines 0 → fail', () => {
    expect(
      readOutputInputSchema.safeParse({ session_id: 'a', max_lines: 0 }).success,
    ).toBe(false);
  });

  it('since_seq 负 → fail', () => {
    expect(
      readOutputInputSchema.safeParse({ session_id: 'a', since_seq: -1 })
        .success,
    ).toBe(false);
  });

  it('未知字段 → fail(strict)', () => {
    expect(
      readOutputInputSchema.safeParse({ session_id: 'a', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('readOutputOutputSchema', () => {
  it('全字段齐 → ok', () => {
    expect(
      readOutputOutputSchema.safeParse({
        lines: ['a', 'b'],
        next_seq: 3,
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it('next_seq 负 → fail', () => {
    expect(
      readOutputOutputSchema.safeParse({
        lines: [],
        next_seq: -1,
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it('lines 含非 string → fail', () => {
    expect(
      readOutputOutputSchema.safeParse({
        lines: ['a', 1],
        next_seq: 0,
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it('额外字段 → fail(strict)', () => {
    expect(
      readOutputOutputSchema.safeParse({
        lines: [],
        next_seq: 0,
        truncated: false,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// makeReadOutputTool · 行为
// ────────────────────────────────────────────────────────────

type ReadFn = (
  id: string,
  opts: { sinceSeq?: number; maxLines?: number; stripAnsi?: boolean },
) => Promise<{ lines: string[]; nextSeq: number; truncated: boolean }>;
const ctx = { ownerWindowId: 1 };
const getSessionOwner = vi.fn(() => 1);

const makeOkRead = (
  result: { lines: string[]; nextSeq: number; truncated: boolean } = {
    lines: [],
    nextSeq: 0,
    truncated: false,
  },
) => vi.fn<ReadFn>(async () => result);

describe('makeReadOutputTool · 元数据', () => {
  it('name 与契约常量一致', () => {
    const tool = makeReadOutputTool({ read: makeOkRead(), getSessionOwner });
    expect(tool.name).toBe(MCP_TOOL_READ_OUTPUT);
  });

  it('inputSchema 是 readOutputInputSchema', () => {
    const tool = makeReadOutputTool({ read: makeOkRead(), getSessionOwner });
    expect(tool.inputSchema).toBe(readOutputInputSchema);
  });
});

describe('makeReadOutputTool · run', () => {
  it('字段映射:snake_case → camelCase 给 deps', async () => {
    const read = makeOkRead();
    const tool = makeReadOutputTool({ read, getSessionOwner });
    await tool.run({
      session_id: 'term-1',
      since_seq: 5,
      max_lines: 100,
      strip_ansi: false,
    }, ctx);
    expect(read).toHaveBeenCalledWith('term-1', {
      sinceSeq: 5,
      maxLines: 100,
      stripAnsi: false,
    });
  });

  it('字段映射:nextSeq → next_seq 输出', async () => {
    const read = makeOkRead({ lines: ['a'], nextSeq: 7, truncated: true });
    const tool = makeReadOutputTool({ read, getSessionOwner });
    const r = await tool.run({ session_id: 't' }, ctx);
    expect(r).toEqual({
      lines: ['a'],
      next_seq: 7,
      truncated: true,
    });
  });

  it('缺省 since_seq / max_lines / strip_ansi → opts 不传(让 service wrapper 用自己默认)', async () => {
    const read = makeOkRead();
    const tool = makeReadOutputTool({ read, getSessionOwner });
    await tool.run({ session_id: 't' }, ctx);
    expect(read).toHaveBeenCalledWith('t', {});
  });

  it('部分给值 → 仅给的字段透传', async () => {
    const read = makeOkRead();
    const tool = makeReadOutputTool({ read, getSessionOwner });
    await tool.run({ session_id: 't', max_lines: 50 }, ctx);
    expect(read).toHaveBeenCalledWith('t', { maxLines: 50 });
  });

  it('read 抛 TERMINAL_SESSION_NOT_FOUND → 透传', async () => {
    const read = vi.fn<ReadFn>(async () => {
      throw Object.assign(new Error('not found'), {
        code: 'TERMINAL_SESSION_NOT_FOUND',
      });
    });
    const tool = makeReadOutputTool({ read, getSessionOwner });
    await expect(tool.run({ session_id: 't' }, ctx)).rejects.toMatchObject({
      code: 'TERMINAL_SESSION_NOT_FOUND',
    });
  });

  it('read 抛其它错 → 透传', async () => {
    const read = vi.fn<ReadFn>(async () => {
      throw Object.assign(new Error('boom'), { code: 'INTERNAL' });
    });
    const tool = makeReadOutputTool({ read, getSessionOwner });
    await expect(tool.run({ session_id: 't' }, ctx)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('输出符合 readOutputOutputSchema', async () => {
    const read = makeOkRead({ lines: ['x', 'y'], nextSeq: 2, truncated: false });
    const tool = makeReadOutputTool({ read, getSessionOwner });
    const out = await tool.run({ session_id: 't' }, ctx);
    expect(readOutputOutputSchema.safeParse(out).success).toBe(true);
  });
});
