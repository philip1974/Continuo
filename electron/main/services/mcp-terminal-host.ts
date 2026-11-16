import { ERROR_CODES } from '../../shared/error-codes';
import { codedError } from '../../shared/error-message';
import type { AnyMcpTool } from './mcp-host.service';
import {
  gateWithAuth,
  gateWithCapability,
  type EnsureAuthorized,
} from './mcp-tool-gates';
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
  type CreateSessionToolDeps,
} from './mcp-tools-terminal';

export type { EnsureAuthorized } from './mcp-tool-gates';

// createSession / installStopHook 的签名以 create_session 工具的 deps 为单一来源。
export interface MakeTerminalMcpToolsDeps
  extends Pick<CreateSessionToolDeps, 'createSession' | 'installStopHook'> {
  readonly sessionStore: Pick<typeof terminalSessions, 'get' | 'getAll' | 'remove'>;
  readonly service: Pick<
    typeof termService,
    'has' | 'write' | 'interrupt' | 'kill' | 'forceKill' | 'readOutput'
  >;
  readonly getSessionOwner: (id: string) => number | null;
  /** 安全 S3:会话的创建方身份(controllerToken),未由 MCP 创建 → null. */
  readonly getSessionController: (id: string) => string | null;
  readonly ensureAuthorized: EnsureAuthorized;
  /**
   * terminal.await_stop_hook(broker 启动失败时省略,不注册)。与 read_output 同等走 auth →
   * capability 门控:它会返回 transcript_path / last_assistant_message,不得被同窗口他方消费。
   */
  readonly awaitStopHookTool?: AnyMcpTool;
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
const TERMINAL_AUTH_GATE = {
  methodFor: (tool: AnyMcpTool): string => tool.name,
  deniedMessage: 'agent terminal not authorized by user',
} as const;

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
export function makeTerminalMcpTools(
  deps: MakeTerminalMcpToolsDeps,
): readonly AnyMcpTool[] {
  // list_sessions:仅 auth 门控(窗口级)。
  const gate = (tool: AnyMcpTool): AnyMcpTool =>
    gateWithAuth(tool, deps.ensureAuthorized, TERMINAL_AUTH_GATE);
  // 读/写/杀类:auth → capability → inner(auth 在外先跑,再校验会话归属调用方)。
  // 跨窗 session_id 不在此拦(无 crossWindowError)→ 内部工具抛 TERMINAL_SESSION_NOT_FOUND。
  const gateOwned = (tool: AnyMcpTool): AnyMcpTool =>
    gate(
      gateWithCapability(tool, {
        getSessionOwner: deps.getSessionOwner,
        getSessionController: deps.getSessionController,
        notOwnedMessage: 'terminal session not owned by caller',
      }),
    );
  const tools: AnyMcpTool[] = [
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
      // 同 revokeAndKillAgentSessions:先删 metadata 再 forceKill(无调用方的会话不留 3s grace)。
      discardSession: (id) => {
        deps.sessionStore.remove(id);
        if (deps.service.has(id)) deps.service.forceKill(id);
      },
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
  if (deps.awaitStopHookTool) {
    // 安全:await_stop_hook 可 block 数分钟,入口 capability 只在开始时校验一次。等待期间用户
    // 「撤销全部授权 / 终止 agent terminal」(删会话 metadata)或会话被杀 → 返回前复查会话仍属本
    // 调用方,否则不交出 transcript_path / last_assistant_message。
    const inner = deps.awaitStopHookTool;
    const recheckOnReturn: AnyMcpTool = {
      ...inner,
      run: async (input: unknown, ctx) => {
        const result: unknown = await inner.run(input, ctx);
        const sid = (input as { session_id?: unknown } | null)?.session_id;
        const stillOwned =
          typeof sid === 'string' &&
          deps.getSessionOwner(sid) === ctx.ownerWindowId &&
          ctx.callerSubject != null &&
          deps.getSessionController(sid) === ctx.callerSubject;
        if (!stillOwned) {
          throw codedError(
            ERROR_CODES.AGENT_NOT_AUTHORIZED,
            'terminal session revoked while awaiting stop hook',
          );
        }
        return result;
      },
    };
    tools.push(gateOwned(recheckOnReturn));
  }
  return tools;
}
