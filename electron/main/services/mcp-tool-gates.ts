// MCP 工具的授权 / capability 门控单一来源(重构:mcp-terminal-host 与 mcp-debug-host 此前各持一份
// gateWithAuth / gateWithCapability,安全判定逐字相同,只有文案 / method / 跨窗策略不同)。
//
// 安全判定只此一处,避免「修了 terminal 域漏了 debug 域」(本仓最高频缺陷类:守卫未传播到兄弟入口):
//   - S2 窗口级授权:工具调用前必须经 ensureAuthorized;denied → AGENT_NOT_AUTHORIZED。
//   - S3 per-session capability:本窗口内的会话只允许其创建方(controllerToken === callerSubject)
//     操作;controller 或 subject 任一为空都拒(user 终端 / 未标识调用方无权)。
//
// BDD: src/__tests__/mcp-tool-gates/

import { ERROR_CODES } from '../../shared/error-codes';
import type { AnyMcpTool, McpCallCtx } from './mcp-host.service';
import { codedError } from '../../shared/error-message';

/**
 * agent 授权门控:owner 窗口 + 调用 method,返回三态决策。external=true 表示调用方是未绑定 Continuo 终端的
 * 外部客户端(ctx.external),main 按独立的调用方类别记授权(不与窗口内 agent 互相放行)。
 */
export type EnsureAuthorized = (
  ownerWindowId: number,
  method: string,
  external: boolean,
  request?: AuthRequestDisplay,
) => Promise<'once' | 'session' | 'denied'>;

/**
 * 授权弹窗的说明素材(只作显示,不参与授权判定 —— 放行仍只看 窗口 × 调用方类别 × 域)。
 * - callerToken:调用方绑定的 MCP token(ctx.callerToken),main 据此反查发起终端;不发给 renderer。
 * - params:本次请求的关键参数(agent 决定的值)。
 */
export interface AuthRequestDisplay {
  readonly callerToken?: string;
  readonly params?: AuthRequestParams;
}

export interface AuthRequestParams {
  readonly command?: string;
  readonly cwd?: string;
  readonly program?: string;
  readonly agentLabel?: string;
}

/** ctx + 参数 → 弹窗说明素材。 */
export function authRequestDisplay(ctx: McpCallCtx, params?: AuthRequestParams): AuthRequestDisplay {
  return {
    ...(ctx.callerToken ? { callerToken: ctx.callerToken } : {}),
    ...(params ? { params } : {}),
  };
}

/** 从原始入参取字符串字段(弹窗说明用;入参尚未经内部工具校验,非字符串忽略)。 */
export function stringField(input: unknown, key: string): string | undefined {
  const v = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : undefined;
}

export interface AuthGateOptions {
  /** 传给授权弹窗的 method(UI 据此显示精确动作)。 */
  readonly methodFor: (tool: AnyMcpTool) => string;
  /** denied 时的错误消息。 */
  readonly deniedMessage: string;
  /** 弹窗里显示的关键参数(只作显示)。 */
  readonly paramsFor?: (tool: AnyMcpTool, input: unknown) => AuthRequestParams | undefined;
}

/**
 * 安全 S2:包一层授权门控。用户未授权该窗口 agent 控制时,工具调用先触发授权弹窗;拒绝即抛
 * AGENT_NOT_AUTHORIZED。用户选「本次启动期间允许」后直接放行(main agent-auth.service 的 sessionGrants 按
 * 窗口 × 调用方类别 × 域判定,域由 agentAuthDomainOf 划分:`debug.` 开头为 debug 域,`plugin.` 开头为插件工具域,
 * 其余为终端域,三个域互不放行)。
 */
export function gateWithAuth(
  tool: AnyMcpTool,
  ensureAuthorized: EnsureAuthorized,
  opts: AuthGateOptions,
): AnyMcpTool {
  const inner = tool.run;
  return {
    ...tool,
    run: async (input: unknown, ctx: McpCallCtx) => {
      // 调用方已断开 / 连接已拒绝 → 不弹授权窗(无人等待该结果)。
      if (ctx.signal?.aborted) {
        throw codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, 'caller disconnected before authorization');
      }
      const decision = await ensureAuthorized(
        ctx.ownerWindowId,
        opts.methodFor(tool),
        ctx.external === true,
        authRequestDisplay(ctx, opts.paramsFor?.(tool, input)),
      );
      if (decision === 'denied') {
        throw codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, opts.deniedMessage);
      }
      // race(R111 同族):用户在授权弹窗上停留期间调用方可能已断开(ctx.signal abort)。即便随后点了
      // 授权也不执行内部工具(send/kill 等副作用不该作用于无调用方的请求),错误与 create_session 同款。
      if (ctx.signal?.aborted) {
        throw codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, 'caller disconnected after authorization');
      }
      return inner(input, ctx);
    },
  };
}

export interface CapabilityGateOptions {
  readonly getSessionOwner: (id: string) => number | null;
  /** 会话的创建方身份(controllerToken),未由 MCP 创建 → null. */
  readonly getSessionController: (id: string) => string | null;
  /** 本窗口会话但调用方不是创建方时的错误消息。 */
  readonly notOwnedMessage: string;
  /**
   * session_id 属于**别的窗口**时抛出的错误(不泄漏存在性)。省略 → 放行给内部工具自行处理
   * (terminal 工具内部按 owner 抛 TERMINAL_SESSION_NOT_FOUND,保持既有跨窗语义)。
   */
  readonly crossWindowError?: (sessionId: string) => Error;
}

/**
 * 安全 S3:per-session capability。仅对「本窗口内」的会话强制 controller === subject;
 * 未知 session_id(owner=null)交给内部工具报 not found。
 */
export function gateWithCapability(
  tool: AnyMcpTool,
  opts: CapabilityGateOptions,
): AnyMcpTool {
  const inner = tool.run;
  return {
    ...tool,
    run: async (input: unknown, ctx: McpCallCtx) => {
      const sid = (input as { session_id?: unknown } | null)?.session_id;
      if (typeof sid === 'string') {
        const owner = opts.getSessionOwner(sid);
        if (owner !== null && owner !== ctx.ownerWindowId && opts.crossWindowError) {
          throw opts.crossWindowError(sid);
        }
        if (owner === ctx.ownerWindowId) {
          const controller = opts.getSessionController(sid);
          const subject = ctx.callerSubject;
          const allowed =
            controller != null && subject != null && controller === subject;
          if (!allowed) {
            throw codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, opts.notOwnedMessage);
          }
        }
      }
      return inner(input, ctx);
    },
  };
}
