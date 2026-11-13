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

/** agent 授权门控:owner 窗口 + 调用 method,返回三态决策. */
export type EnsureAuthorized = (
  ownerWindowId: number,
  method?: string,
) => Promise<'once' | 'session' | 'denied'>;

export interface AuthGateOptions {
  /** 传给授权弹窗的 method(UI 据此显示精确动作)。 */
  readonly methodFor: (tool: AnyMcpTool) => string;
  /** denied 时的错误消息。 */
  readonly deniedMessage: string;
}

/**
 * 安全 S2:包一层授权门控。用户未授权该窗口 agent 控制时,工具调用先触发授权弹窗;拒绝即抛
 * AGENT_NOT_AUTHORIZED。已建立 session 授权后直接放行(renderer 的 agent-auth store 按域短路:
 * method 以 `debug.` 开头的看 debug 域,其余看终端域,两个域互不放行)。
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
      const decision = await ensureAuthorized(ctx.ownerWindowId, opts.methodFor(tool));
      if (decision === 'denied') {
        throw codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, opts.deniedMessage);
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
