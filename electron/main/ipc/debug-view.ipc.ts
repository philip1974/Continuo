import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  defaultIsTrustedFrame,
  safeHandleWithWindow,
} from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  DEBUG_STACK_LEVELS_MAX,
  DEBUG_STRING_BYTES_DEFAULT,
  DEBUG_VARIABLE_COUNT_MAX,
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

// 导出供回归测试;sessionId / threadId 与各项上限同 MCP debug 工具共用 shared 定义(threadId 含合法的 0)。
// 上限只存在于入口 schema(debug.service 原样使用、按 maxDepth 递归发 DAP 请求),两个入口必须同值 ——
// 此前面板 IPC 手写了更宽的 1000 / 10 / 1MB,而 MCP 侧是 100 / 5 / 64KiB。
export const debugGetStackInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    threadId: threadIdSchema,
    startFrame: z.number().int().min(0).max(100_000).optional(),
    levels: z.number().int().min(1).max(DEBUG_STACK_LEVELS_MAX).optional(),
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
    start: z.number().int().min(0).max(100_000).optional(),
    count: z.number().int().min(1).max(DEBUG_VARIABLE_COUNT_MAX).optional(),
    maxDepth: z.number().int().min(1).max(DEBUG_VARIABLE_DEPTH_MAX).optional(),
    maxStringBytes: z.number().int().min(1).max(DEBUG_STRING_BYTES_DEFAULT).optional(),
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
  const trusted = defaultIsTrustedFrame;

  const windowScopedHandle = <I>(
    channel: string,
    schema: z.ZodType<I>,
    handler: (input: I, win: BrowserWindow) => unknown | Promise<unknown>,
  ): void => safeHandleWithWindow(channel, schema, handler, trusted, ERROR_CODES.NO_WINDOW);

  windowScopedHandle(DEBUG_VIEW_CHANNELS.SUBSCRIBE, debugSubscribeInputSchema, (_input, win) => {
    return {
      sessions: service
        .listSessions()
        .filter((session) => session.owner_window_id === win.id),
    };
  });

  windowScopedHandle(DEBUG_VIEW_CHANNELS.GET_STACK, debugGetStackInputSchema, (input: DebugGetStackInput, win) => {
    const session = requireStoppedSession(input.sessionId, win);
    const threadId = input.threadId ?? session.currentThreadId;
    if (threadId === undefined) {
      throw codedError(ERROR_CODES.BAD_INPUT, `debug session has no stopped thread: ${input.sessionId}`);
    }
    return service.stackTrace(input.sessionId, {
      threadId,
      startFrame: input.startFrame,
      levels: input.levels,
    });
  });

  windowScopedHandle(DEBUG_VIEW_CHANNELS.GET_SCOPES, debugGetScopesInputSchema, (input: DebugGetScopesInput, win) => {
    requireStoppedSession(input.sessionId, win);
    return service.scopes(input.sessionId, { frameId: input.frameId });
  });

  windowScopedHandle(DEBUG_VIEW_CHANNELS.GET_VARIABLES, debugGetVariablesInputSchema, (input: DebugGetVariablesInput, win) => {
    requireStoppedSession(input.sessionId, win);
    return service.variables(input.sessionId, {
      variablesReference: input.variablesReference,
      start: input.start,
      count: input.count,
      maxDepth: input.maxDepth,
      maxStringBytes: input.maxStringBytes,
    });
  });
}
