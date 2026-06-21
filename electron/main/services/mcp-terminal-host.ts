import { ERROR_CODES } from '../../shared/error-codes';
import type { AnyMcpTool, McpCallCtx } from './mcp-host.service';
import type * as terminalSessions from './terminal-sessions.service';
import type * as termService from './terminal.service';
import {
  makeCreateSessionTool,
  makeKillTool,
  makeListSessionsTool,
  makePressKeyTool,
  makeReadOutputTool,
  makeSendInputTool,
  makeSendTextTool,
  type CreateSessionPtyInput,
} from './mcp-tools-terminal';

/** agent 授权门控:owner 窗口 + 调用 method,返回三态决策. */
export type EnsureAuthorized = (
  ownerWindowId: number,
  method?: string,
) => Promise<'once' | 'session' | 'denied'>;

export interface MakeTerminalMcpToolsDeps {
  readonly sessionStore: Pick<typeof terminalSessions, 'get' | 'getAll'>;
  readonly service: Pick<
    typeof termService,
    'has' | 'write' | 'interrupt' | 'kill' | 'forceKill' | 'readOutput'
  >;
  readonly getSessionOwner: (id: string) => number | null;
  /** 安全 S3:会话的创建方身份(controllerToken),未由 MCP 创建 → null. */
  readonly getSessionController: (id: string) => string | null;
  readonly ensureAuthorized: EnsureAuthorized;
  readonly createSession: (
    input: CreateSessionPtyInput,
    ctx: McpCallCtx,
  ) => Promise<{ id: string }>;
  readonly installStopHook?: (
    cwd: string | undefined,
    agentLabel: string,
  ) => Promise<{ installed: boolean; reason?: string }>;
}

/**
 * 安全 S2(codex 安全审计):MCP 的 token/url 被注入到**所有** PTY(用户在 terminal
 * 跑 claude/codex 时自动反连 host)。但读/写/杀类工具此前只按 ownerWindowId 校验
 * 会话归属,**不校验调用方是否已获 agent 授权** → 恶意 workspace 脚本(依赖
 * postinstall 等)在普通 terminal 里读环境变量拿到 CONTINUO_MCP_TOKEN,即可
 * `list_sessions`/`read_output`/`send_input`/`press_key`/`kill` 越权读控同窗口
 * 其它终端(含 agent 会话),不经任何授权弹窗 → 跨终端泄漏与会话劫持。
 *
 * 修复:把这些工具包一层与 create_session 同款的 ensureAuthorized 门控。用户未授权
 * 该窗口 agent terminal 控制时,任意工具调用都先触发授权弹窗;一旦拒绝即抛
 * AGENT_NOT_AUTHORIZED。合法 agent 流首个 create_session 已建立 session 授权,
 * 后续读写直接放行(renderer store sessionGranted 短路),不增加交互。
 *
 * create_session 不在此包装:它已在工具内部门控,且 renderer 授权 store 同一时刻
 * 只允许一个 pending(第二条并发 ensure 立即 denied),外层再包会与内部门控并发
 * 自我拒绝。
 */
function gateWithAuth(
  tool: AnyMcpTool,
  ensureAuthorized: EnsureAuthorized,
): AnyMcpTool {
  const inner = tool.run;
  return {
    ...tool,
    run: async (input: unknown, ctx: McpCallCtx) => {
      const decision = await ensureAuthorized(ctx.ownerWindowId, tool.name);
      if (decision === 'denied') {
        throw Object.assign(
          new Error('agent terminal not authorized by user'),
          { code: ERROR_CODES.AGENT_NOT_AUTHORIZED },
        );
      }
      return inner(input, ctx);
    },
  };
}

/**
 * 安全 S3(codex 安全审计·S2 深化):S2 的授权是**窗口级**单布尔(sessionGranted),
 * 故「用户已授权该窗口 agent terminal 控制后,同窗口另一个终端里的恶意进程(持自动
 * 注入的 token / 直连 stdio socket)仍可横向 read/inject/kill 其它会话」。
 *
 * 修复:per-session capability。create_session 把新会话盖上调用方身份
 * (controllerToken = ctx.callerSubject;HTTP=bearer token,stdio=每连接 subject)。
 * read/send/kill 只允许操作「本窗口内且由本调用方创建」的会话:
 *   controller != null && subject != null && controller === subject。
 * user 终端(Cmd+T)无 controllerToken → 任何 MCP 调用方都无权;别的 token/连接创建
 * 的会话 controller 不等 → 拒。capability 随会话生命周期自动清理(状态盖在会话元数据,
 * 无独立 map 需 GC)。
 *
 * 仅对「本窗口内」的会话强制;跨窗/未知 session_id 交给内部工具抛
 * TERMINAL_SESSION_NOT_FOUND(不泄漏存在性,保持既有跨窗语义)。list_sessions 不加
 * capability(仅窗口级):它只暴露 id/title/cwd 元数据,而 id 本身无法被利用 ——
 * read/inject/kill 已 capability-gated;保留 list 全窗口视图不损失 agent 上下文。
 */
function gateWithCapability(
  tool: AnyMcpTool,
  getSessionOwner: (id: string) => number | null,
  getSessionController: (id: string) => string | null,
): AnyMcpTool {
  const inner = tool.run;
  return {
    ...tool,
    run: async (input: unknown, ctx: McpCallCtx) => {
      const sid = (input as { session_id?: unknown } | null)?.session_id;
      if (typeof sid === 'string' && getSessionOwner(sid) === ctx.ownerWindowId) {
        const controller = getSessionController(sid);
        const subject = ctx.callerSubject;
        const allowed =
          controller != null && subject != null && controller === subject;
        if (!allowed) {
          throw Object.assign(
            new Error('terminal session not owned by caller'),
            { code: ERROR_CODES.AGENT_NOT_AUTHORIZED },
          );
        }
      }
      return inner(input, ctx);
    },
  };
}

export function makeTerminalMcpTools(
  deps: MakeTerminalMcpToolsDeps,
): readonly AnyMcpTool[] {
  // list_sessions:仅 auth 门控(窗口级)。
  const gate = (tool: AnyMcpTool): AnyMcpTool =>
    gateWithAuth(tool, deps.ensureAuthorized);
  // 读/写/杀类:auth → capability → inner(auth 在外先跑,再校验会话归属调用方)。
  const gateOwned = (tool: AnyMcpTool): AnyMcpTool =>
    gateWithAuth(
      gateWithCapability(tool, deps.getSessionOwner, deps.getSessionController),
      deps.ensureAuthorized,
    );
  return [
    gate(
      makeListSessionsTool({
        getSessions: (ctx) =>
          deps.sessionStore.getAll({ ownerWindowId: ctx.ownerWindowId }),
      }),
    ),
    makeCreateSessionTool({
      ensureAuthorized: deps.ensureAuthorized,
      createSession: deps.createSession,
      installStopHook: deps.installStopHook,
    }),
    gateOwned(
      makeSendInputTool({
        has: deps.service.has,
        write: deps.service.write,
        getSessionOwner: deps.getSessionOwner,
      }),
    ),
    gateOwned(
      makeSendTextTool({
        has: deps.service.has,
        write: deps.service.write,
        getSessionOwner: deps.getSessionOwner,
      }),
    ),
    gateOwned(
      makePressKeyTool({
        has: deps.service.has,
        write: deps.service.write,
        getSessionOwner: deps.getSessionOwner,
      }),
    ),
    gateOwned(
      makeReadOutputTool({
        read: deps.service.readOutput,
        getSessionOwner: deps.getSessionOwner,
      }),
    ),
    gateOwned(
      makeKillTool({
        has: deps.service.has,
        interrupt: deps.service.interrupt,
        kill: deps.service.kill,
        forceKill: deps.service.forceKill,
        getSessionOwner: deps.getSessionOwner,
      }),
    ),
  ];
}
