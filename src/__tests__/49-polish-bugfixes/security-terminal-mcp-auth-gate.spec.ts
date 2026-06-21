// 安全 S2(codex 安全审计):MCP 的 token/url 被自动注入到**所有** PTY(用户在
// terminal 跑 claude/codex 时反连 host)。此前只有 create_session 走 agent 授权门控,
// 而 list_sessions / read_output / send_input / send_text / press_key / kill 仅按
// ownerWindowId 校验会话归属,**不校验调用方是否已获授权** → 恶意 workspace 脚本
// (依赖 postinstall 等)在普通 terminal 读环境变量拿到 CONTINUO_MCP_TOKEN,即可越权
// 枚举/读取/注入/杀同窗口其它终端(含 agent 会话),不经任何授权弹窗 → 跨终端泄漏
// 与会话劫持。
//
// 修复:makeTerminalMcpTools 把这 6 个工具包一层与 create_session 同款 ensureAuthorized
// 门控。本规范锁定:决策为 'denied' → 抛 AGENT_NOT_AUTHORIZED;'once'/'session' → 放行
// 且把正确 method 标签 + ownerWindowId 传给授权器。
import { describe, it, expect, vi } from 'vitest';
import { makeTerminalMcpTools } from '../../../electron/main/services/mcp-terminal-host';
import type {
  AnyMcpTool,
  McpCallCtx,
} from '../../../electron/main/services/mcp-host.service';

const OWNER = 10;

function findTool(tools: readonly AnyMcpTool[], name: string): AnyMcpTool {
  const t = tools.find((x) => x.name === name);
  expect(t, `tool ${name} should exist`).toBeDefined();
  return t!;
}

const SUBJECT = 'token-abc'; // 调用方身份;target 会话 controller 也设为它 → capability 通过

/** ensureAuthorized mock 可控决策;target 会话默认归属 OWNER 窗口 + 由 SUBJECT 创建. */
function buildTools(decision: 'once' | 'session' | 'denied') {
  const ensureAuthorized = vi.fn(async () => decision);
  const service = {
    has: vi.fn(() => true),
    write: vi.fn(() => true),
    interrupt: vi.fn(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    readOutput: vi.fn(async () => ({ data: 'x', lines: ['x'], nextSeq: 1, truncated: false })),
  };
  const tools = makeTerminalMcpTools({
    sessionStore: {
      get: () => undefined,
      getAll: () => [],
    } as never,
    service: service as never,
    getSessionOwner: () => OWNER, // 任意 session 都归属 OWNER → scope 校验通过
    getSessionController: () => SUBJECT, // 会话由 SUBJECT 创建 → capability 通过
    ensureAuthorized: ensureAuthorized as never,
    createSession: vi.fn(async () => ({ id: 'created' })),
  });
  return { tools, ensureAuthorized, service };
}

const GATED: ReadonlyArray<{ name: string; input: Record<string, unknown> }> = [
  { name: 'terminal.list_sessions', input: {} },
  { name: 'terminal.read_output', input: { session_id: 'S' } },
  { name: 'terminal.send_input', input: { session_id: 'S', data: 'ls\r' } },
  { name: 'terminal.send_text', input: { session_id: 'S', text: 'ls' } },
  { name: 'terminal.press_key', input: { session_id: 'S', key: 'enter' } },
  { name: 'terminal.kill', input: { session_id: 'S', signal: 'SIGTERM' } },
];

describe('安全 S2 — terminal MCP 读/写/杀工具授权门控', () => {
  const ctx: McpCallCtx = { ownerWindowId: OWNER, callerSubject: SUBJECT };

  it('decision=denied → 6 个工具全部抛 AGENT_NOT_AUTHORIZED(核心安全断言)', async () => {
    const { tools } = buildTools('denied');
    for (const { name, input } of GATED) {
      await expect(
        findTool(tools, name).run(input as never, ctx),
        `${name} 应在未授权时拒绝`,
      ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    }
  });

  it('denied 时不触达底层副作用(write/forceKill 等不被调用)', async () => {
    const { tools, service } = buildTools('denied');
    await findTool(tools, 'terminal.send_input')
      .run({ session_id: 'S', data: 'x' } as never, ctx)
      .catch(() => {});
    await findTool(tools, 'terminal.kill')
      .run({ session_id: 'S', signal: 'SIGKILL' } as never, ctx)
      .catch(() => {});
    expect(service.write).not.toHaveBeenCalled();
    expect(service.forceKill).not.toHaveBeenCalled();
    expect(service.kill).not.toHaveBeenCalled();
  });

  it("decision=session → 放行,read_output 触达底层 read", async () => {
    const { tools, service } = buildTools('session');
    await findTool(tools, 'terminal.read_output').run(
      { session_id: 'S' } as never,
      ctx,
    );
    expect(service.readOutput).toHaveBeenCalledWith('S', expect.anything());
  });

  it('门控把正确 method 标签 + ownerWindowId 传给授权器(弹窗显示用)', async () => {
    for (const { name, input } of GATED) {
      const { tools, ensureAuthorized } = buildTools('once');
      await findTool(tools, name).run(input as never, ctx).catch(() => {});
      expect(ensureAuthorized).toHaveBeenCalledWith(OWNER, name);
    }
  });

  it('create_session 不被外层重复门控(仅工具内部门控一次,防并发 pending 自拒)', async () => {
    // create_session 内部已 ensureAuthorized;外层若再包,与内部并发会触发
    // renderer store「已有 pending → 第二条 denied」。这里验证外层未包装:授权器
    // 在一次 create 调用中恰好被调用一次。
    const { tools, ensureAuthorized } = buildTools('session');
    await findTool(tools, 'terminal.create_session').run(
      {} as never,
      ctx,
    );
    expect(ensureAuthorized).toHaveBeenCalledTimes(1);
  });
});
