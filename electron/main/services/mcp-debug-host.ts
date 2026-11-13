import {
  MCP_TOOL_DEBUG_LAUNCH,
  MCP_TOOL_DEBUG_LIST_SESSIONS,
} from '../../shared/mcp-debug-schemas';
import { ERROR_CODES } from '../../shared/error-codes';
import { codedError } from '../../shared/error-message';
import type { AnyMcpTool } from './mcp-host.service';
import {
  gateWithAuth,
  gateWithCapability,
  type EnsureAuthorized,
} from './mcp-tool-gates';
import {
  makeDebugTools,
  type DebugToolService,
} from './mcp-tools-debug';

/** debug 域授权门控(与 terminal 域同一签名;独立命名保留既有导出)。 */
export type EnsureDebugAuthorized = EnsureAuthorized;

export interface MakeDebugMcpToolsDeps {
  readonly service: DebugToolService;
  readonly getSessionOwner: (id: string) => number | null;
  readonly getSessionController: (id: string) => string | null;
  readonly ensureAuthorized: EnsureDebugAuthorized;
}

// 跨窗 session_id 与不存在的 session_id 必须不可区分(同一 code、同一文案、不回显 id)—— 否则调用方能
// 据错误形态探测别的窗口是否有该会话。与 mcp-tools-debug 对「不存在」的归一化结果一致。
function debugSessionNotFound(): Error {
  return codedError(ERROR_CODES.DEBUG_SESSION_NOT_FOUND, 'debug session not found');
}

/**
 * debug 授权复用 agent-auth 的窗口级授权弹窗:
 * - launch 用 method=debug.launch,让 UI 能显示精确动作。
 * - 其它 debug 工具统一走 method=debug.*。
 */
const DEBUG_AUTH_GATE = {
  methodFor: (tool: AnyMcpTool): string =>
    tool.name === MCP_TOOL_DEBUG_LAUNCH ? 'debug.launch' : 'debug.*',
  deniedMessage: 'agent debug not authorized by user',
} as const;

/**
 * Per-session capability:
 * - session_id 不属于当前窗口 → not found,避免跨窗泄漏和误操作。
 * - 当前窗口 session 必须由同一 MCP callerSubject 创建。
 */
export function makeDebugMcpTools(
  deps: MakeDebugMcpToolsDeps,
): readonly AnyMcpTool[] {
  const gate = (tool: AnyMcpTool): AnyMcpTool =>
    gateWithAuth(tool, deps.ensureAuthorized, DEBUG_AUTH_GATE);
  const gateOwned = (tool: AnyMcpTool): AnyMcpTool =>
    gate(
      gateWithCapability(tool, {
        getSessionOwner: deps.getSessionOwner,
        getSessionController: deps.getSessionController,
        notOwnedMessage: 'debug session not owned by caller',
        crossWindowError: debugSessionNotFound,
      }),
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
