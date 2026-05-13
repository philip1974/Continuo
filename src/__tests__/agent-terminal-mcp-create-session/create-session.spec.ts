// BDD: agent-terminal-mcp-create-session
// terminal.create_session MCP tool 契约层。
// 此 spec 在 P2 实装前会 red(常量与 schema 暂未 export)。

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_TOOL_CREATE_SESSION,
  createSessionInputSchema,
  createSessionOutputSchema,
} from '../../../electron/shared/mcp-terminal-schemas';
import {
  makeCreateSessionTool,
  type CreateSessionPtyInput,
} from '../../../electron/main/services/mcp-tools-terminal';

// ────────────────────────────────────────────────────────────
// 常量 + Schema
// ────────────────────────────────────────────────────────────

describe('MCP_TOOL_CREATE_SESSION', () => {
  it('字符串契约', () => {
    expect(MCP_TOOL_CREATE_SESSION).toBe('terminal.create_session');
  });
});

describe('createSessionInputSchema', () => {
  it('空对象 → ok(全字段 optional)', () => {
    expect(createSessionInputSchema.safeParse({}).success).toBe(true);
  });

  it('全字段 → ok', () => {
    expect(
      createSessionInputSchema.safeParse({
        cwd: '/work',
        name: 'codex',
        agentLabel: 'codex',
      }).success,
    ).toBe(true);
  });

  it('autorun 字段(P3)→ ok', () => {
    expect(
      createSessionInputSchema.safeParse({ autorun: 'codex' }).success,
    ).toBe(true);
  });

  it('未知字段 → fail', () => {
    expect(
      createSessionInputSchema.safeParse({ extra: 1 }).success,
    ).toBe(false);
  });
});

describe('createSessionOutputSchema', () => {
  it('正常 → ok', () => {
    expect(
      createSessionOutputSchema.safeParse({ session_id: 'term-1' }).success,
    ).toBe(true);
  });

  it('缺 session_id → fail', () => {
    expect(createSessionOutputSchema.safeParse({}).success).toBe(false);
  });

  it('空 session_id → fail', () => {
    expect(
      createSessionOutputSchema.safeParse({ session_id: '' }).success,
    ).toBe(false);
  });

  it('未知字段 → fail(strict)', () => {
    expect(
      createSessionOutputSchema.safeParse({ session_id: 'x', extra: 1 }).success,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// makeCreateSessionTool — handler 行为
// ────────────────────────────────────────────────────────────

type CreateSessionFn = (
  input: CreateSessionPtyInput,
  ctx: { ownerWindowId: number },
) => Promise<{ id: string }>;
type EnsureAuthFn = () => Promise<'once' | 'session' | 'denied'>;
const ctx = { ownerWindowId: 1 };

const makeOkDeps = (overrides?: {
  ensureAuthorized?: EnsureAuthFn;
  createSession?: CreateSessionFn;
}) => ({
  ensureAuthorized:
    overrides?.ensureAuthorized ?? vi.fn<EnsureAuthFn>(async () => 'session'),
  createSession:
    overrides?.createSession ??
    vi.fn<CreateSessionFn>(async () => ({ id: 'term-x' })),
});

describe('makeCreateSessionTool · 元数据', () => {
  it('name 与契约常量一致', () => {
    const tool = makeCreateSessionTool(makeOkDeps());
    expect(tool.name).toBe(MCP_TOOL_CREATE_SESSION);
  });

  it('inputSchema 是 createSessionInputSchema', () => {
    const tool = makeCreateSessionTool(makeOkDeps());
    expect(tool.inputSchema).toBe(createSessionInputSchema);
  });
});

describe('makeCreateSessionTool · 授权', () => {
  it('denied → 抛 AGENT_NOT_AUTHORIZED,不调 createSession', async () => {
    const ensureAuthorized = vi.fn<EnsureAuthFn>(async () => 'denied');
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'never' }));
    const tool = makeCreateSessionTool({ ensureAuthorized, createSession });
    await expect(tool.run({}, ctx)).rejects.toMatchObject({
      code: 'AGENT_NOT_AUTHORIZED',
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("'once' → 调 createSession + 返回 session_id", async () => {
    const ensureAuthorized = vi.fn<EnsureAuthFn>(async () => 'once');
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'term-once' }));
    const tool = makeCreateSessionTool({ ensureAuthorized, createSession });
    const r = await tool.run({}, ctx);
    expect(r).toEqual({ session_id: 'term-once' });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("'session' → 调 createSession + 返回 session_id", async () => {
    const ensureAuthorized = vi.fn<EnsureAuthFn>(async () => 'session');
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'term-sess' }));
    const tool = makeCreateSessionTool({ ensureAuthorized, createSession });
    const r = await tool.run({}, ctx);
    expect(r).toEqual({ session_id: 'term-sess' });
  });
});

describe('makeCreateSessionTool · 字段透传', () => {
  it('cwd 给值 → 透传', async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({ cwd: '/proj' }, ctx);
    expect(createSession.mock.calls[0]![0]).toMatchObject({ cwd: '/proj' });
  });

  it('cwd 缺省 → 不传', async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({}, ctx);
    expect('cwd' in createSession.mock.calls[0]![0]).toBe(false);
  });

  it('name 给值 → 透传', async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({ name: 'codex' }, ctx);
    expect(createSession.mock.calls[0]![0]).toMatchObject({ name: 'codex' });
  });

  it('name 缺省 → 不传', async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({}, ctx);
    expect('name' in createSession.mock.calls[0]![0]).toBe(false);
  });

  it('agentLabel 给值 → 透传', async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({ agentLabel: 'gemini' }, ctx);
    expect(createSession.mock.calls[0]![0]).toMatchObject({
      agentLabel: 'gemini',
    });
  });

  it("agentLabel 缺省 → 默认 'agent'", async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({}, ctx);
    expect(createSession.mock.calls[0]![0]).toMatchObject({
      agentLabel: 'agent',
    });
  });

  it("永远 originHint='agent'", async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({}, ctx);
    expect(createSession.mock.calls[0]![0]).toMatchObject({
      originHint: 'agent',
    });
  });

  it('autorun 给值 → 透传(P3)', async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({ autorun: 'codex' }, ctx);
    expect(createSession.mock.calls[0]![0]).toMatchObject({
      autorun: 'codex',
    });
  });

  it('autorun 缺省 → 不传', async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await tool.run({}, ctx);
    expect('autorun' in createSession.mock.calls[0]![0]).toBe(false);
  });
});

describe('makeCreateSessionTool · 错误透传', () => {
  it('createSession 抛 → 不吞', async () => {
    const createSession = vi.fn<CreateSessionFn>(async () => {
      throw Object.assign(new Error('shell forbidden'), {
        code: 'TERMINAL_FORBIDDEN_SHELL',
      });
    });
    const tool = makeCreateSessionTool(makeOkDeps({ createSession }));
    await expect(tool.run({}, ctx)).rejects.toMatchObject({
      code: 'TERMINAL_FORBIDDEN_SHELL',
    });
  });
});

describe('makeCreateSessionTool · 输出合规', () => {
  it('输出符合 createSessionOutputSchema', async () => {
    const tool = makeCreateSessionTool(makeOkDeps());
    const out = await tool.run({}, ctx);
    expect(createSessionOutputSchema.safeParse(out).success).toBe(true);
  });
});
