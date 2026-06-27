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
import { PATH_MAX, LABEL_MAX } from '../../../electron/shared/terminal-create';

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

  // 边界(E202):inputSchema 不再是协议原 schema,而是 omit 未消费字段(shell/args/cols/rows/env)
  // 的 Continuo-local bounded schema —— 那些字段本工具不消费,协议 schema 的 args/env 无上限会成放大面。
  it('E202 inputSchema 拒绝未消费字段 args/env/shell/cols/rows(strict omit,浅拒不深校验)', () => {
    const tool = makeCreateSessionTool(makeOkDeps());
    // 消费字段照常通过
    expect(tool.inputSchema.safeParse({ cwd: '/x', autorun: 'codex' }).success).toBe(
      true,
    );
    // 未消费字段 → 被 strict omit 拒(unrecognized key)
    expect(tool.inputSchema.safeParse({ args: ['a'] }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({ env: { K: 'v' } }).success,
    ).toBe(false);
    expect(tool.inputSchema.safeParse({ shell: '/bin/sh' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ cols: 80 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ rows: 24 }).success).toBe(false);
    // 协议原 schema 仍接受这些字段(对比:本工具刻意收窄,不动协议)
    expect(createSessionInputSchema.safeParse({ args: ['a'] }).success).toBe(true);
  });

  // 边界(E205,E203/E204 同族):cwd/name/agentLabel/autorun 在 zod inputSchema + advertised jsonSchema
  // 都补 .max/maxLength(此前只 run() 兜底 → 三层漂移)。
  it('E205 inputSchema 对 cwd/name/agentLabel/autorun 加长度上限', () => {
    const tool = makeCreateSessionTool(makeOkDeps());
    expect(
      tool.inputSchema.safeParse({ cwd: '/' + 'x'.repeat(PATH_MAX) }).success,
    ).toBe(false); // 超 PATH_MAX
    expect(
      tool.inputSchema.safeParse({ name: 'x'.repeat(LABEL_MAX + 1) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ agentLabel: 'x'.repeat(LABEL_MAX + 1) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ autorun: 'x'.repeat(65537) }).success,
    ).toBe(false); // 超 MCP_AUTORUN_MAX(65536)
    // 上限内照常通过
    expect(
      tool.inputSchema.safeParse({ cwd: '/repo', name: 'T', autorun: 'ls' }).success,
    ).toBe(true);
  });

  it('E205 advertised jsonSchema 同步声明 cwd/name/agentLabel/autorun 的 maxLength', () => {
    const tool = makeCreateSessionTool(makeOkDeps());
    const props = (tool.jsonSchema.properties ?? {}) as Record<
      string,
      { maxLength?: number }
    >;
    expect(props.cwd?.maxLength).toBe(PATH_MAX);
    expect(props.name?.maxLength).toBe(LABEL_MAX);
    expect(props.agentLabel?.maxLength).toBe(LABEL_MAX);
    expect(props.autorun?.maxLength).toBe(65536);
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

  // race(R111):调用方(stdio proxy)在用户授权 await 期间断开 → ctx.signal abort。即便用户随后点
  // 授权,也不创建会话(否则留无调用方孤儿 agent terminal)。授权后、副作用前复查 signal。
  it('授权 await 期间 ctx.signal abort → 抛,不调 createSession', async () => {
    const controller = new AbortController();
    // 模拟:授权解析时连接已断开(proxy 退出),signal 在 ensureAuthorized 期间被 abort。
    const ensureAuthorized = vi.fn<EnsureAuthFn>(async () => {
      controller.abort();
      return 'session';
    });
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'never' }));
    const tool = makeCreateSessionTool({ ensureAuthorized, createSession });
    const abortedCtx = { ownerWindowId: 1, signal: controller.signal };
    await expect(tool.run({}, abortedCtx)).rejects.toMatchObject({
      code: 'AGENT_NOT_AUTHORIZED',
    });
    expect(createSession).not.toHaveBeenCalled(); // 不创建孤儿会话
  });

  it('signal 未 abort(连接正常)→ 正常创建会话', async () => {
    const controller = new AbortController();
    const ensureAuthorized = vi.fn<EnsureAuthFn>(async () => 'session');
    const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'term-ok' }));
    const tool = makeCreateSessionTool({ ensureAuthorized, createSession });
    const liveCtx = { ownerWindowId: 1, signal: controller.signal };
    const r = await tool.run({}, liveCtx);
    expect(r).toEqual({ session_id: 'term-ok' });
    expect(createSession).toHaveBeenCalledOnce();
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

// 边界(E32):MCP create_session 走 raw ptyCreateHandler 绕过有上限的 TerminalCreateInputSchema
// (E11),协议包 createSessionInputSchema 又无 cwd/name/agentLabel/autorun/target 上限。工具入口
// 按 Continuo 自有上限 fail-closed,且在授权弹窗与任何副作用之前拒绝。
describe('makeCreateSessionTool · 入参尺寸 fail-closed(E32)', () => {
  const overLimitCases: Array<[string, Record<string, unknown>]> = [
    ['cwd 超 PATH_MAX', { cwd: '/' + 'x'.repeat(PATH_MAX) }],
    ['name 超 LABEL_MAX', { name: 'x'.repeat(LABEL_MAX + 1) }],
    ['agentLabel 超 LABEL_MAX', { agentLabel: 'x'.repeat(LABEL_MAX + 1) }],
    ['autorun 超 64KB', { autorun: 'x'.repeat(65537) }],
    // 边界(E133,E125 同族):autorun 64KB 是字节 backstop。CJK 3 bytes/字:~22K 字 = 66KB 字节但
    // length 22K ≤ 64KB,旧 .length 会误放行。
    ['autorun 多字节真实字节超 64KB', { autorun: '中'.repeat(22 * 1024) }],
    ['target.panelId 超 256', { target: { kind: 'panel', panelId: 'x'.repeat(257) } }],
  ];

  it.each(overLimitCases)(
    '%s → 抛 BAD_INPUT,不弹授权、不创建',
    async (_label, input) => {
      const ensureAuthorized = vi.fn<EnsureAuthFn>(async () => 'session');
      const createSession = vi.fn<CreateSessionFn>(async () => ({ id: 'never' }));
      const tool = makeCreateSessionTool({ ensureAuthorized, createSession });
      await expect(tool.run(input, ctx)).rejects.toMatchObject({
        code: 'BAD_INPUT',
      });
      expect(ensureAuthorized).not.toHaveBeenCalled(); // 校验先于授权弹窗
      expect(createSession).not.toHaveBeenCalled();
    },
  );

  it('上限内的正常入参 → 正常创建', async () => {
    const tool = makeCreateSessionTool(makeOkDeps());
    const r = await tool.run(
      {
        cwd: '/work',
        name: 'codex',
        agentLabel: 'codex',
        autorun: 'echo hi',
        target: { kind: 'panel', panelId: 'term-1' },
      },
      ctx,
    );
    expect(createSessionOutputSchema.safeParse(r).success).toBe(true);
  });
});
