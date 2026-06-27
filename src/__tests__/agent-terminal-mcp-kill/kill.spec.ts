// BDD: agent-terminal-mcp-kill

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_TOOL_KILL,
  killInputSchema,
  killOutputSchema,
} from '../../../electron/shared/mcp-terminal-schemas';
import { makeKillTool } from '../../../electron/main/services/mcp-tools-terminal';

// ────────────────────────────────────────────────────────────
// 常量 + Schema
// ────────────────────────────────────────────────────────────

describe('MCP_TOOL_KILL', () => {
  it('字符串契约', () => {
    expect(MCP_TOOL_KILL).toBe('terminal.kill');
  });
});

describe('killInputSchema', () => {
  it('仅 session_id → ok', () => {
    expect(killInputSchema.safeParse({ session_id: 'a' }).success).toBe(true);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGKILL'])('signal=%s → ok', (sig) => {
    expect(
      killInputSchema.safeParse({ session_id: 'a', signal: sig }).success,
    ).toBe(true);
  });

  it.each(['SIGHUP', 'KILL', 'sigterm', ''])(
    'signal 不在白名单(%s)→ fail',
    (sig) => {
      expect(
        killInputSchema.safeParse({ session_id: 'a', signal: sig }).success,
      ).toBe(false);
    },
  );

  it('缺 session_id → fail', () => {
    expect(killInputSchema.safeParse({}).success).toBe(false);
  });

  it('session_id 空字符串 → fail', () => {
    expect(killInputSchema.safeParse({ session_id: '' }).success).toBe(false);
  });

  it('未知字段 → fail(strict)', () => {
    expect(
      killInputSchema.safeParse({ session_id: 'a', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('killOutputSchema', () => {
  it('空对象 → ok', () => {
    expect(killOutputSchema.safeParse({}).success).toBe(true);
  });

  it('额外字段 → fail(strict)', () => {
    expect(killOutputSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// makeKillTool · 行为
// ────────────────────────────────────────────────────────────

type HasFn = (id: string) => boolean;
type SignalFn = (id: string) => void;
type GetSessionOwnerFn = (id: string) => number | null;
const ctx = { ownerWindowId: 1 };

const makeDeps = (overrides?: {
  has?: HasFn;
  interrupt?: SignalFn;
  kill?: SignalFn;
  forceKill?: SignalFn;
  getSessionOwner?: GetSessionOwnerFn;
}) => ({
  has: overrides?.has ?? vi.fn<HasFn>(() => true),
  interrupt: overrides?.interrupt ?? vi.fn<SignalFn>(() => {}),
  kill: overrides?.kill ?? vi.fn<SignalFn>(() => {}),
  forceKill: overrides?.forceKill ?? vi.fn<SignalFn>(() => {}),
  getSessionOwner:
    overrides?.getSessionOwner ?? vi.fn<GetSessionOwnerFn>(() => 1),
});

describe('makeKillTool · 元数据', () => {
  it('name 与契约常量一致', () => {
    const tool = makeKillTool(makeDeps());
    expect(tool.name).toBe(MCP_TOOL_KILL);
  });

  // 边界(E203):inputSchema 是 session_id 加 .max(SESSION_ID_MAX) 的 bounded schema(协议原 schema 无上限)。
  it('E203 inputSchema 对 session_id 加长度上限(超 256 → 拒)', () => {
    const tool = makeKillTool(makeDeps());
    const longId = 'term-' + 'x'.repeat(300);
    expect(tool.inputSchema.safeParse({ session_id: longId }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ session_id: 'term-1' }).success).toBe(true);
    expect(killInputSchema.safeParse({ session_id: longId }).success).toBe(true);
    // 边界(E204):公开 jsonSchema 同步声明 maxLength:256(advertised↔运行时一致)。
    expect(JSON.stringify(tool.jsonSchema)).toContain('"maxLength":256');
  });
});

describe('makeKillTool · run', () => {
  it('has=false → 抛 TERMINAL_SESSION_NOT_FOUND', async () => {
    const has = vi.fn<HasFn>(() => false);
    const interrupt = vi.fn<SignalFn>(() => {});
    const kill = vi.fn<SignalFn>(() => {});
    const forceKill = vi.fn<SignalFn>(() => {});
    const tool = makeKillTool(makeDeps({ has, interrupt, kill, forceKill }));
    await expect(
      tool.run({ session_id: 'nope' }, ctx),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(forceKill).not.toHaveBeenCalled();
  });

  it('signal 缺省 → 调 kill(SIGTERM 行为)', async () => {
    const deps = makeDeps();
    const tool = makeKillTool(deps);
    const r = await tool.run({ session_id: 'term-1' }, ctx);
    expect(r).toEqual({});
    expect(deps.kill).toHaveBeenCalledWith('term-1');
    expect(deps.interrupt).not.toHaveBeenCalled();
    expect(deps.forceKill).not.toHaveBeenCalled();
  });

  it("signal='SIGTERM' → 调 kill", async () => {
    const deps = makeDeps();
    const tool = makeKillTool(deps);
    await tool.run({ session_id: 'term-1', signal: 'SIGTERM' }, ctx);
    expect(deps.kill).toHaveBeenCalledWith('term-1');
    expect(deps.interrupt).not.toHaveBeenCalled();
    expect(deps.forceKill).not.toHaveBeenCalled();
  });

  it("signal='SIGINT' → 调 interrupt", async () => {
    const deps = makeDeps();
    const tool = makeKillTool(deps);
    await tool.run({ session_id: 'term-1', signal: 'SIGINT' }, ctx);
    expect(deps.interrupt).toHaveBeenCalledWith('term-1');
    expect(deps.kill).not.toHaveBeenCalled();
    expect(deps.forceKill).not.toHaveBeenCalled();
  });

  it("signal='SIGKILL' → 调 forceKill", async () => {
    const deps = makeDeps();
    const tool = makeKillTool(deps);
    await tool.run({ session_id: 'term-1', signal: 'SIGKILL' }, ctx);
    expect(deps.forceKill).toHaveBeenCalledWith('term-1');
    expect(deps.kill).not.toHaveBeenCalled();
    expect(deps.interrupt).not.toHaveBeenCalled();
  });

  it('输出符合 killOutputSchema', async () => {
    const tool = makeKillTool(makeDeps());
    const out = await tool.run({ session_id: 't' }, ctx);
    expect(killOutputSchema.safeParse(out).success).toBe(true);
  });
});
