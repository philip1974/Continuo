// 规则 2:调用方断开(ctx.signal abort)后不执行副作用。
// gateWithAuth 在 ensureAuthorized 返回后复查;create_session 在 installStopHook 返回后复查。
import { describe, expect, it, vi } from 'vitest';
import { gateWithAuth } from '../../../electron/main/services/mcp-tool-gates';
import { makeCreateSessionTool } from '../../../electron/main/services/mcp-tools-terminal';
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
