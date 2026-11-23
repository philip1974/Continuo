import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  safeHandleWithWindow,
} from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  DEBUG_VARIABLE_DEPTH_MAX,
  sessionIdSchema,
  threadIdSchema,
} from '../../shared/mcp-debug-schemas';
import {
  DEBUG_VIEW_CHANNELS,
  type DebugGetScopesInput,
  type DebugGetStackInput,
  type DebugGetVariablesInput,
} from '../../shared/debug-view-channels';
import type { DebugService } from '../services/debug.service';
import * as debugSessions from '../services/debug-sessions.service';
import { codedError } from '../../shared/error-message';

const debugSubscribeInputSchema = z.object({}).strict();

// 导出供回归测试;sessionId / threadId 与 maxDepth 上限同 MCP debug 工具共用 shared 定义(threadId 含合法的 0)。
// 面板只暴露它实际用到的入参;分页 / 截断等其余参数走 debug.service 的默认值。
export const debugGetStackInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    threadId: threadIdSchema,
  })
  .strict();

const debugGetScopesInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    frameId: z.number().int().nonnegative(),
  })
  .strict();

const debugGetVariablesInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    variablesReference: z.number().int().positive(),
    maxDepth: z.number().int().min(1).max(DEBUG_VARIABLE_DEPTH_MAX).optional(),
  })
  .strict();

function requireOwnedDebugSession(sessionId: string, win: BrowserWindow) {
  const session = debugSessions.get(sessionId);
  if (!session || session.ownerWindowId !== win.id) {
    throw codedError(ERROR_CODES.DEBUG_SESSION_NOT_FOUND, `debug session not found: ${sessionId}`);
  }
  return session;
}

function requireStoppedSession(sessionId: string, win: BrowserWindow) {
  const session = requireOwnedDebugSession(sessionId, win);
  if (session.runtimeState !== 'stopped') {
    throw codedError(ERROR_CODES.BAD_INPUT, `debug session is not stopped: ${sessionId}`);
  }
  return session;
}

export function registerDebugViewIpc(service: DebugService): void {

  const windowScopedHandle = <I>(
    channel: string,
    schema: z.ZodType<I>,
    handler: (input: I, win: BrowserWindow) => unknown | Promise<unknown>,
  ): void => safeHandleWithWindow(channel, schema, handler, ERROR_CODES.NO_WINDOW);

  // 快照只含本窗口的会话(含停点与按 source 的断点,供 renderer 重载后恢复);断点数在 service 侧封顶。
  windowScopedHandle(DEBUG_VIEW_CHANNELS.SUBSCRIBE, debugSubscribeInputSchema, (_input, win) => {
    return { sessions: service.viewSnapshot(win.id) };
  });

  windowScopedHandle(DEBUG_VIEW_CHANNELS.GET_STACK, debugGetStackInputSchema, (input: DebugGetStackInput, win) => {
    const session = requireStoppedSession(input.sessionId, win);
    const threadId = input.threadId ?? session.currentThreadId;
    if (threadId === undefined) {
      throw codedError(ERROR_CODES.BAD_INPUT, `debug session has no stopped thread: ${input.sessionId}`);
    }
    return service.stackTrace(input.sessionId, { threadId });
  });

  windowScopedHandle(DEBUG_VIEW_CHANNELS.GET_SCOPES, debugGetScopesInputSchema, (input: DebugGetScopesInput, win) => {
    requireStoppedSession(input.sessionId, win);
    return service.scopes(input.sessionId, { frameId: input.frameId });
  });

  windowScopedHandle(DEBUG_VIEW_CHANNELS.GET_VARIABLES, debugGetVariablesInputSchema, (input: DebugGetVariablesInput, win) => {
    requireStoppedSession(input.sessionId, win);
    return service.variables(input.sessionId, {
      variablesReference: input.variablesReference,
      maxDepth: input.maxDepth,
    });
  });
}
