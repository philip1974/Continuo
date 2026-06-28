import { ERROR_CODES } from '../../shared/error-codes';
import {
  MCP_TOOL_DEBUG_LAUNCH,
  MCP_TOOL_DEBUG_LIST_SESSIONS,
} from '../../shared/mcp-debug-schemas';
import type { AnyMcpTool, McpCallCtx } from './mcp-host.service';
import {
  makeDebugTools,
  type DebugToolService,
} from './mcp-tools-debug';

/** agent 授权门控:owner 窗口 + 调用 method,返回三态决策. */
export type EnsureDebugAuthorized = (
  ownerWindowId: number,
  method?: string,
) => Promise<'once' | 'session' | 'denied'>;

export interface MakeDebugMcpToolsDeps {
  readonly service: DebugToolService;
  readonly getSessionOwner: (id: string) => number | null;
  readonly getSessionController: (id: string) => string | null;
  readonly ensureAuthorized: EnsureDebugAuthorized;
}

function debugSessionNotFound(sessionId: string): Error {
  return new Error(`debug session not found: ${sessionId}`);
}

/**
 * debug 授权复用 agent-auth 的窗口级授权弹窗:
 * - launch 用 method=debug.launch,让 UI 能显示精确动作。
 * - 其它 debug 工具统一走 method=debug.*。
 */
function gateWithAuth(
  tool: AnyMcpTool,
  ensureAuthorized: EnsureDebugAuthorized,
): AnyMcpTool {
  const inner = tool.run;
  return {
    ...tool,
    run: async (input: unknown, ctx: McpCallCtx) => {
      const method = tool.name === MCP_TOOL_DEBUG_LAUNCH ? 'debug.launch' : 'debug.*';
      const decision = await ensureAuthorized(ctx.ownerWindowId, method);
      if (decision === 'denied') {
        throw Object.assign(new Error('agent debug not authorized by user'), {
          code: ERROR_CODES.AGENT_NOT_AUTHORIZED,
        });
      }
      return inner(input, ctx);
    },
  };
}

/**
 * Per-session capability:
 * - session_id 不属于当前窗口 → not found,避免跨窗泄漏和误操作。
 * - 当前窗口 session 必须由同一 MCP callerSubject 创建。
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
      if (typeof sid === 'string') {
        const owner = getSessionOwner(sid);
        if (owner !== null && owner !== ctx.ownerWindowId) {
          throw debugSessionNotFound(sid);
        }
        if (owner === ctx.ownerWindowId) {
          const controller = getSessionController(sid);
          const subject = ctx.callerSubject;
          const allowed =
            controller != null && subject != null && controller === subject;
          if (!allowed) {
            throw Object.assign(
              new Error('debug session not owned by caller'),
              { code: ERROR_CODES.AGENT_NOT_AUTHORIZED },
            );
          }
        }
      }
      return inner(input, ctx);
    },
  };
}

export function makeDebugMcpTools(
  deps: MakeDebugMcpToolsDeps,
): readonly AnyMcpTool[] {
  const gate = (tool: AnyMcpTool): AnyMcpTool =>
    gateWithAuth(tool, deps.ensureAuthorized);
  const gateOwned = (tool: AnyMcpTool): AnyMcpTool =>
    gateWithAuth(
      gateWithCapability(tool, deps.getSessionOwner, deps.getSessionController),
      deps.ensureAuthorized,
    );

  const tools = makeDebugTools({ service: deps.service });
  return tools.map((tool) => {
    if (
      tool.name === MCP_TOOL_DEBUG_LAUNCH ||
      tool.name === MCP_TOOL_DEBUG_LIST_SESSIONS
    ) {
      return gate(tool);
    }
    return gateOwned(tool);
  });
}
