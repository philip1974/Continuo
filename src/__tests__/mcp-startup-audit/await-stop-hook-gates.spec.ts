// 规则 1:terminal.await_stop_hook 与 read_output 同等的 S2 授权 + S3 per-session capability。
// 此前它在 index.ts 于 makeTerminalMcpTools 之外单独注册,getSessionMeta 只校验 ownerWindowId →
// 同窗口另一个调用方可消费他人会话的 Stop hook(transcript_path / last_assistant_message)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTerminalMcpTools } from '../../../electron/main/services/mcp-terminal-host';
import { createAwaitStopHookTool } from '../../../electron/main/services/mcp-tools-hook-bridge';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import type { AnyMcpTool, McpCallCtx } from '../../../electron/main/services/mcp-host.service';

const WIN = 3;
const ME = 'subj-me';
const OTHER = 'subj-other';

type Sess = { owner: number; controller: string | null };

function build(
  sessions: Record<string, Sess>,
  decision: 'once' | 'session' | 'denied' = 'session',
) {
  const awaitNext = vi.fn(async () => ({
    payload: {
      cliSessionId: 'cli',
      turnId: 't',
      cwd: '/w',
      transcriptPath: '/secret/transcript.jsonl',
      lastAssistantMessage: 'secret',
      raw: {},
    },
  }));
  const awaitStopHookTool = createAwaitStopHookTool({
    broker: { awaitNext } as never,
    getSessionMeta: (id, ctx) => {
      const s = sessions[id];
      if (!s || s.owner !== ctx.ownerWindowId) return null;
      return { id, cwd: '/w', agentLabel: 'codex' };
    },
  }) as unknown as AnyMcpTool;
  const ensureAuthorized = vi.fn(async () => decision);
  const tools = makeTerminalMcpTools({
    // 复查要求会话仍 live(exitCode === null);record 中存在即视为 live。
    sessionStore: {
      get: (id: string) => (sessions[id] ? { exitCode: null } : undefined),
      getAll: () => [],
    } as never,
    service: {} as never,
    getSessionOwner: (id) => sessions[id]?.owner ?? null,
    getSessionController: (id) => sessions[id]?.controller ?? null,
    ensureAuthorized,
    createSession: vi.fn(async () => ({ id: 'x' })),
    awaitStopHookTool,
  });
  const tool = tools.find((t) => t.name === 'terminal.await_stop_hook');
  return { tool, awaitNext, ensureAuthorized };
}

const ctxMe: McpCallCtx = { ownerWindowId: WIN, callerSubject: ME };
const input = (id: string) => ({ session_id: id, timeout_sec: 1 });

describe('规则 1 · await_stop_hook 授权 + capability', () => {
  it('经 makeTerminalMcpTools 注册', () => {
    expect(build({}).tool).toBeDefined();
  });

  it('同窗口他方创建的会话 → AGENT_NOT_AUTHORIZED,不消费 Stop hook', async () => {
    const { tool, awaitNext } = build({ peer: { owner: WIN, controller: OTHER } });
    await expect(tool!.run(input('peer'), ctxMe)).rejects.toMatchObject({
      code: 'AGENT_NOT_AUTHORIZED',
    });
    expect(awaitNext).not.toHaveBeenCalled();
  });

  it('user 终端(无 controller)→ AGENT_NOT_AUTHORIZED', async () => {
    const { tool, awaitNext } = build({ user: { owner: WIN, controller: null } });
    await expect(tool!.run(input('user'), ctxMe)).rejects.toMatchObject({
      code: 'AGENT_NOT_AUTHORIZED',
    });
    expect(awaitNext).not.toHaveBeenCalled();
  });

  it('授权被拒 → AGENT_NOT_AUTHORIZED,不消费 Stop hook', async () => {
    const { tool, awaitNext } = build({ mine: { owner: WIN, controller: ME } }, 'denied');
    await expect(tool!.run(input('mine'), ctxMe)).rejects.toMatchObject({
      code: 'AGENT_NOT_AUTHORIZED',
    });
    expect(awaitNext).not.toHaveBeenCalled();
  });

  it('本调用方创建的会话 → 放行,经授权门控(method = 工具名)', async () => {
    const { tool, awaitNext, ensureAuthorized } = build({
      mine: { owner: WIN, controller: ME },
    });
    await expect(tool!.run(input('mine'), ctxMe)).resolves.toMatchObject({
      status: 'stop',
    });
    expect(awaitNext).toHaveBeenCalledTimes(1);
    expect(ensureAuthorized).toHaveBeenCalledWith(WIN, 'terminal.await_stop_hook', false);
  });

  it('跨窗会话 → TERMINAL_SESSION_NOT_FOUND(不泄漏存在性)', async () => {
    const { tool, awaitNext } = build({ far: { owner: WIN + 1, controller: ME } });
    await expect(tool!.run(input('far'), ctxMe)).rejects.toMatchObject({
      code: 'TERMINAL_SESSION_NOT_FOUND',
    });
    expect(awaitNext).not.toHaveBeenCalled();
  });

  // 撤销授权(revokeAndKillAgentSessions 删 agent 会话 metadata)/ 会话被杀发生在等待期间:
  // 在途 waiter 不得再把 transcript_path / last_assistant_message 交给调用方。
  it('等待期间会话被撤销(metadata 删除)→ 不返回 Stop hook 数据', async () => {
    const sessions: Record<string, Sess> = { mine: { owner: WIN, controller: ME } };
    const { tool, awaitNext } = build(sessions);
    let release!: () => void;
    awaitNext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              payload: {
                cliSessionId: 'cli',
                turnId: 't',
                cwd: '/w',
                transcriptPath: '/secret/transcript.jsonl',
                lastAssistantMessage: 'secret',
                raw: {},
              },
            });
        }),
    );
    const pending = tool!.run(input('mine'), ctxMe);
    await vi.waitFor(() => expect(awaitNext).toHaveBeenCalled());
    delete sessions['mine']; // 用户「终止全部 agent terminal」
    release();
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  });

  it('等待期间 controller 变更 → 不返回 Stop hook 数据', async () => {
    const sessions: Record<string, Sess> = { mine: { owner: WIN, controller: ME } };
    const { tool, awaitNext } = build(sessions);
    let release!: () => void;
    awaitNext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ elapsedMs: 1 } as never); // 超时结果
        }),
    );
    const pending = tool!.run(input('mine'), ctxMe);
    await vi.waitFor(() => expect(awaitNext).toHaveBeenCalled());
    sessions['mine'] = { owner: WIN, controller: OTHER };
    release();
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  });

  // PTY 退出 → 真实状态机 live → exited-retained(setExited,metadata 保留、owner/controller 不变):
  // 仅比对 owner/controller 会漏判,复查须同时要求会话仍 live。
  it('等待期间 PTY 退出(exited-retained)→ 不返回 Stop hook 数据', async () => {
    terminalSessions._reset();
    terminalSessions.add({
      id: 'live1',
      title: 't',
      cwd: '/w',
      originHint: 'agent',
      agentLabel: 'codex',
      ownerWindowId: WIN,
      controllerToken: ME,
    });
    let release!: () => void;
    const awaitNext = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ elapsedMs: 1 });
        }),
    );
    const tools = makeTerminalMcpTools({
      sessionStore: terminalSessions,
      service: {} as never,
      getSessionOwner: (id) => terminalSessions.get(id)?.ownerWindowId ?? null,
      getSessionController: (id) => terminalSessions.getController(id),
      ensureAuthorized: async () => 'session',
      createSession: vi.fn(async () => ({ id: 'x' })),
      awaitStopHookTool: createAwaitStopHookTool({
        broker: { awaitNext } as never,
        getSessionMeta: (id) => terminalSessions.get(id) ?? null,
      }) as unknown as AnyMcpTool,
    });
    const tool = tools.find((t) => t.name === 'terminal.await_stop_hook')!;
    const pending = tool.run(input('live1'), ctxMe);
    await vi.waitFor(() => expect(awaitNext).toHaveBeenCalled());
    terminalSessions.setExited('live1', 0);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    terminalSessions._reset();
  });

  it('接线守卫:index.ts 不在 makeTerminalMcpTools 之外单独 push await_stop_hook', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'electron', 'main', 'index.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/initialTools\.push\(\s*createAwaitStopHookTool/);
    expect(src).toMatch(/awaitStopHookTool:/);
  });
});
