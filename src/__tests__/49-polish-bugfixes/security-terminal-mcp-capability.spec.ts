// 安全 S3(codex 安全审计·S2 深化):S2 的授权是**窗口级**单布尔 —— 用户授权某窗口
// agent terminal 控制后,同窗口另一终端里的恶意进程(持自动注入 token / 直连 stdio
// socket)仍可横向 read/inject/kill 其它会话。修复:per-session capability —— create
// 把会话盖上调用方身份(controllerToken = ctx.callerSubject),read/send/kill 只允许
// 操作「本窗口内且由本调用方创建」的会话。
//
// 本规范把 ensureAuthorized 固定为 'session'(auth 恒通过),以隔离 capability 这一层。
import { describe, it, expect, vi } from 'vitest';
import { makeTerminalMcpTools } from '../../../electron/main/services/mcp-terminal-host';
import type {
  AnyMcpTool,
  McpCallCtx,
} from '../../../electron/main/services/mcp-host.service';

const WIN = 10;
const ME = 'token-me'; // 当前调用方 subject
const OTHER = 'token-other'; // 另一调用方(另一终端 / 另一 stdio 连接)

type Sess = { owner: number; controller: string | null };

/** sessions: id → {owner, controller}. ensureAuthorized 恒 'session'(隔离 auth). */
function build(sessions: Record<string, Sess>) {
  const service = {
    has: vi.fn(() => true),
    write: vi.fn(() => true),
    interrupt: vi.fn(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    readOutput: vi.fn(async () => ({ data: '', lines: [], nextSeq: 0, truncated: false })),
  };
  const tools = makeTerminalMcpTools({
    sessionStore: {
      get: () => undefined,
      getAll: (f?: { ownerWindowId?: number }) =>
        Object.entries(sessions)
          .filter(([, s]) => f?.ownerWindowId === undefined || s.owner === f.ownerWindowId)
          .map(([id, s]) => ({
            id,
            title: id,
            cwd: '/x',
            originHint: s.controller ? 'agent' : 'user',
            createdAt: 1,
            exitCode: null,
            ownerWindowId: s.owner,
          })),
    } as never,
    service: service as never,
    getSessionOwner: (id: string) => sessions[id]?.owner ?? null,
    getSessionController: (id: string) => sessions[id]?.controller ?? null,
    ensureAuthorized: vi.fn(async () => 'session' as const),
    createSession: vi.fn(async () => ({ id: 'created' })),
  });
  return { tools, service };
}

function tool(tools: readonly AnyMcpTool[], name: string): AnyMcpTool {
  return tools.find((t) => t.name === name)!;
}

const OWNED: ReadonlyArray<{ name: string; input: (id: string) => Record<string, unknown> }> = [
  { name: 'terminal.read_output', input: (id) => ({ session_id: id }) },
  { name: 'terminal.send_input', input: (id) => ({ session_id: id, data: 'x' }) },
  { name: 'terminal.send_text', input: (id) => ({ session_id: id, text: 'x' }) },
  { name: 'terminal.press_key', input: (id) => ({ session_id: id, key: 'enter' }) },
  { name: 'terminal.kill', input: (id) => ({ session_id: id, signal: 'SIGTERM' }) },
];

describe('安全 S3 — per-session capability(横向接管防护)', () => {
  const ctxMe: McpCallCtx = { ownerWindowId: WIN, callerSubject: ME };

  it('同窗口、会话由**他方**创建 → read/send/kill 全部 AGENT_NOT_AUTHORIZED(核心横向防护)', async () => {
    const { tools, service } = build({ peer: { owner: WIN, controller: OTHER } });
    for (const { name, input } of OWNED) {
      await expect(
        tool(tools, name).run(input('peer') as never, ctxMe),
        `${name} 不应能操作他方会话`,
      ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    }
    expect(service.write).not.toHaveBeenCalled();
    expect(service.readOutput).not.toHaveBeenCalled();
    expect(service.kill).not.toHaveBeenCalled();
  });

  it('user 终端(无 controllerToken)→ 任何 MCP 调用方都无权 read/send/kill', async () => {
    const { tools } = build({ userTerm: { owner: WIN, controller: null } });
    for (const { name, input } of OWNED) {
      await expect(
        tool(tools, name).run(input('userTerm') as never, ctxMe),
      ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    }
  });

  it('会话由**本调用方**创建(controller === subject)→ 放行,触达底层', async () => {
    const { tools, service } = build({ mine: { owner: WIN, controller: ME } });
    await tool(tools, 'terminal.read_output').run({ session_id: 'mine' } as never, ctxMe);
    await tool(tools, 'terminal.send_input').run(
      { session_id: 'mine', data: 'x' } as never,
      ctxMe,
    );
    expect(service.readOutput).toHaveBeenCalledWith('mine', expect.anything());
    expect(service.write).toHaveBeenCalled();
  });

  it('调用方 subject 为空(null)→ 即便会话无 controller 也拒(fail-closed,不 null===null 误放)', async () => {
    const { tools } = build({ userTerm: { owner: WIN, controller: null } });
    const ctxNull: McpCallCtx = { ownerWindowId: WIN, callerSubject: null };
    await expect(
      tool(tools, 'terminal.read_output').run({ session_id: 'userTerm' } as never, ctxNull),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  });

  it('跨窗口会话 → 不走 capability,交内部工具抛 TERMINAL_SESSION_NOT_FOUND(保持既有语义)', async () => {
    const { tools } = build({ otherWin: { owner: 99, controller: OTHER } });
    await expect(
      tool(tools, 'terminal.read_output').run({ session_id: 'otherWin' } as never, ctxMe),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
  });

  it('list_sessions 不受 capability 限制(仅窗口级;id 元数据无法被利用,read/kill 已 gated)', async () => {
    const { tools } = build({
      mine: { owner: WIN, controller: ME },
      peer: { owner: WIN, controller: OTHER },
      userTerm: { owner: WIN, controller: null },
    });
    const out = (await tool(tools, 'terminal.list_sessions').run({} as never, ctxMe)) as {
      sessions: Array<{ session_id: string }>;
    };
    expect(out.sessions.map((s) => s.session_id).sort()).toEqual([
      'mine',
      'peer',
      'userTerm',
    ]);
  });
});
