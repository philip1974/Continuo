// 规则 2:调用方断开(ctx.signal abort)后不执行副作用。
// gateWithAuth 在 ensureAuthorized 返回后复查;create_session 在 installStopHook 返回后复查。
import { describe, expect, it, vi } from 'vitest';
import { gateWithAuth } from '../../../electron/main/services/mcp-tool-gates';
import { makeCreateSessionTool } from '../../../electron/main/services/mcp-tools-terminal';
import { makeTerminalMcpTools } from '../../../electron/main/services/mcp-terminal-host';
import type { AnyMcpTool, McpCallCtx } from '../../../electron/main/services/mcp-host.service';

const AUTH = { methodFor: (t: AnyMcpTool) => t.name, deniedMessage: 'denied' };

describe('规则 2 · gateWithAuth 授权返回后复查 abort', () => {
  it('授权等待期间调用方断开 → AGENT_NOT_AUTHORIZED,内部工具不执行', async () => {
    const aborter = new AbortController();
    const run = vi.fn(async () => ({ ok: true }));
    const tool = { name: 't', description: '', jsonSchema: {}, run } as unknown as AnyMcpTool;
    const gated = gateWithAuth(
      tool,
      async () => {
        aborter.abort(); // 用户在弹窗上停留期间连接断开,随后点了授权
        return 'session';
      },
      AUTH,
    );
    const ctx: McpCallCtx = { ownerWindowId: 1, callerSubject: 's', signal: aborter.signal };
    await expect(gated.run({}, ctx)).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(run).not.toHaveBeenCalled();
  });

  it('进入门控时已断开 → 不调用 ensureAuthorized(不弹授权窗),AGENT_NOT_AUTHORIZED', async () => {
    const aborter = new AbortController();
    aborter.abort();
    const run = vi.fn(async () => ({ ok: true }));
    const ensureAuthorized = vi.fn(async () => 'session' as const);
    const tool = { name: 't', description: '', jsonSchema: {}, run } as unknown as AnyMcpTool;
    const gated = gateWithAuth(tool, ensureAuthorized, AUTH);
    const ctx: McpCallCtx = { ownerWindowId: 1, callerSubject: 's', signal: aborter.signal };
    await expect(gated.run({}, ctx)).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(ensureAuthorized).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('未断开 → 照常放行', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const tool = { name: 't', description: '', jsonSchema: {}, run } as unknown as AnyMcpTool;
    const gated = gateWithAuth(tool, async () => 'session', AUTH);
    const ctx: McpCallCtx = {
      ownerWindowId: 1,
      callerSubject: 's',
      signal: new AbortController().signal,
    };
    await expect(gated.run({}, ctx)).resolves.toEqual({ ok: true });
  });
});

describe('规则 2 · create_session installStopHook 返回后复查 abort', () => {
  it('安装 Stop hook 期间调用方断开 → 不 createSession', async () => {
    const aborter = new AbortController();
    const createSession = vi.fn(async () => ({ id: 'x' }));
    const tool = makeCreateSessionTool({
      ensureAuthorized: async () => 'session',
      installStopHook: async () => {
        aborter.abort();
        return { installed: true };
      },
      createSession,
    });
    const ctx: McpCallCtx = { ownerWindowId: 1, callerSubject: 's', signal: aborter.signal };
    await expect(
      tool.run({ install_stop_hook: true, agentLabel: 'codex' } as never, ctx),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(createSession).not.toHaveBeenCalled();
  });
});

// 安全(F2):create_session 直接调 ensureAuthorized(不经 gateWithAuth),同样须带上外部客户端标记。
describe('F2 · create_session 授权带 external 标记', () => {
  it.each([
    [true, true],
    [undefined, false],
  ])('ctx.external=%s → ensureAuthorized 第三参 %s', async (external, expected) => {
    const ensureAuthorized = vi.fn(async () => 'denied' as const);
    const tool = makeCreateSessionTool({
      ensureAuthorized,
      installStopHook: async () => ({ installed: true }),
      createSession: vi.fn(async () => ({ id: 'x' })),
    });
    const ctx: McpCallCtx = {
      ownerWindowId: 1,
      callerSubject: 's',
      signal: new AbortController().signal,
      ...(external !== undefined ? { external } : {}),
    };
    await expect(tool.run({} as never, ctx)).rejects.toMatchObject({
      code: 'AGENT_NOT_AUTHORIZED',
    });
    expect(ensureAuthorized).toHaveBeenCalledWith(1, 'terminal.create_session', expected);
  });
});

describe('规则 2 · create_session 在 PTY 创建期间断开 → 回收会话', () => {
  it('createSession 完成时调用方已断开 → kill PTY + 删 metadata,以取消错误结束', async () => {
    const aborter = new AbortController();
    const remove = vi.fn();
    const forceKill = vi.fn();
    const tools = makeTerminalMcpTools({
      sessionStore: { get: () => undefined, getAll: () => [], remove } as never,
      service: { has: () => true, forceKill } as never,
      getSessionOwner: () => 1,
      getSessionController: () => 's',
      ensureAuthorized: async () => 'session',
      createSession: async () => {
        aborter.abort(); // spawn 进行中连接断开
        return { id: 'orphan' };
      },
    });
    const tool = tools.find((t) => t.name === 'terminal.create_session')!;
    const ctx: McpCallCtx = { ownerWindowId: 1, callerSubject: 's', signal: aborter.signal };
    await expect(tool.run({}, ctx)).rejects.toMatchObject({ code: 'TERMINAL_CREATE_CANCELLED' });
    expect(remove).toHaveBeenCalledWith('orphan');
    expect(forceKill).toHaveBeenCalledWith('orphan');
  });
});
