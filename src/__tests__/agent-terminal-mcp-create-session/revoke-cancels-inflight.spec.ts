// BDD: agent-terminal-mcp-create-session · 撤销授权覆盖在途 create_session
// 授权已通过、PTY 尚未登记(installStopHook / spawn 期间)时用户「撤销授权并终止全部 agent 终端」:
// 撤销只杀已登记会话。在途创建须被取消:不建 PTY;已建则回收,且不执行 autorun。
// 同族:debug.launch 在途登记(吊销调用方覆盖在途 debug.launch)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeCreateSessionTool,
  type CreateSessionPtyInput,
} from '../../../electron/main/services/mcp-tools-terminal';
import { cancelAgentTerminalCreates } from '../../../electron/main/services/agent-terminal-inflight';
import type { McpCallCtx } from '../../../electron/main/services/mcp-host.service';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { deferred } from '../_helpers/async';

afterEach(() => {
  cancelAgentTerminalCreates();
});

describe('撤销授权覆盖在途 terminal.create_session', () => {
  it('installStopHook 挂起期间撤销 → 不建 PTY,以取消错误结束', async () => {
    const hook = deferred<{ installed: boolean }>();
    const createSession = vi.fn(async () => ({ id: 'term-1' }));
    const tool = makeCreateSessionTool({
      ensureAuthorized: async () => 'session',
      installStopHook: () => hook.promise,
      createSession,
      discardSession: vi.fn(),
    });
    const run = tool.run(
      { install_stop_hook: true, autorun: 'codex' },
      { ownerWindowId: 1, callerSubject: 'tok-a' },
    );
    await Promise.resolve();
    cancelAgentTerminalCreates();
    hook.resolve({ installed: true });
    await expect(run).rejects.toMatchObject({ code: ERROR_CODES.AGENT_NOT_AUTHORIZED });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('PTY spawn 期间撤销 → 回收 PTY,交给 createSession 的取消信号已触发(autorun 不执行)', async () => {
    const spawn = deferred<{ id: string }>();
    let seenCtx: McpCallCtx | undefined;
    const createSession = vi.fn(async (_input: CreateSessionPtyInput, c: McpCallCtx) => {
      seenCtx = c;
      return spawn.promise;
    });
    const discardSession = vi.fn();
    const tool = makeCreateSessionTool({
      ensureAuthorized: async () => 'session',
      createSession,
      discardSession,
    });
    const run = tool.run({ autorun: 'codex' }, { ownerWindowId: 1, callerSubject: 'tok-a' });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    cancelAgentTerminalCreates();
    // autorun 由 createSession 实现依据该信号跳过(makeAgentCreateSession,见 agent-create-session.spec)。
    expect(seenCtx?.signal?.aborted).toBe(true);
    spawn.resolve({ id: 'term-1' });
    await expect(run).rejects.toMatchObject({ code: ERROR_CODES.TERMINAL_CREATE_CANCELLED });
    expect(discardSession).toHaveBeenCalledWith('term-1');
  });

  it('只取消指定调用方:其它调用方的在途创建照常完成', async () => {
    const hookA = deferred<{ installed: boolean }>();
    const hookB = deferred<{ installed: boolean }>();
    const hooks = [hookA, hookB];
    const createSession = vi.fn(async () => ({ id: `term-${createSession.mock.calls.length}` }));
    const discardSession = vi.fn();
    const tool = makeCreateSessionTool({
      ensureAuthorized: async () => 'session',
      installStopHook: () => hooks.shift()!.promise,
      createSession,
      discardSession,
    });
    const runA = tool.run({ install_stop_hook: true }, { ownerWindowId: 1, callerSubject: 'tok-a' });
    const runB = tool.run({ install_stop_hook: true }, { ownerWindowId: 1, callerSubject: 'tok-b' });
    await Promise.resolve();
    cancelAgentTerminalCreates('tok-a');
    hookA.resolve({ installed: true });
    hookB.resolve({ installed: true });
    await expect(runA).rejects.toMatchObject({ code: ERROR_CODES.AGENT_NOT_AUTHORIZED });
    await expect(runB).resolves.toMatchObject({ session_id: 'term-1' });
    expect(discardSession).not.toHaveBeenCalled();
  });

  it('创建结束后不再登记:之后的撤销不影响新的创建', async () => {
    const tool = makeCreateSessionTool({
      ensureAuthorized: async () => 'session',
      createSession: async () => ({ id: 'term-9' }),
    });
    await tool.run({}, { ownerWindowId: 1, callerSubject: 'tok-a' });
    cancelAgentTerminalCreates('tok-a');
    await expect(
      tool.run({}, { ownerWindowId: 1, callerSubject: 'tok-a' }),
    ).resolves.toMatchObject({ session_id: 'term-9' });
  });
});
