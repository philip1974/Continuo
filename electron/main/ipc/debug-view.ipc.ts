import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  defaultIsTrustedFrame,
  safeHandleWithWindow,
} from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  DEBUG_VIEW_CHANNELS,
  type DebugGetScopesInput,
  type DebugGetStackInput,
  type DebugGetVariablesInput,
} from '../../shared/debug-view-channels';
import type { DebugService } from '../services/debug.service';
import * as debugSessions from '../services/debug-sessions.service';

const debugSubscribeInputSchema = z.object({}).strict();

const debugGetStackInputSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    threadId: z.number().int().positive().optional(),
    startFrame: z.number().int().min(0).max(100_000).optional(),
    levels: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

const debugGetScopesInputSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    frameId: z.number().int().nonnegative(),
  })
  .strict();

const debugGetVariablesInputSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    variablesReference: z.number().int().positive(),
    start: z.number().int().min(0).max(100_000).optional(),
    count: z.number().int().min(1).max(1_000).optional(),
    maxDepth: z.number().int().min(1).max(10).optional(),
    maxStringBytes: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

function requireOwnedDebugSession(sessionId: string, win: BrowserWindow) {
  const session = debugSessions.get(sessionId);
  if (!session || session.ownerWindowId !== win.id) {
    throw Object.assign(new Error(`debug session not found: ${sessionId}`), {
      code: ERROR_CODES.DEBUG_SESSION_NOT_FOUND,
    });
  }
  return session;
}

function requireStoppedSession(sessionId: string, win: BrowserWindow) {
  const session = requireOwnedDebugSession(sessionId, win);
  if (session.runtimeState !== 'stopped') {
    throw Object.assign(new Error(`debug session is not stopped: ${sessionId}`), {
      code: ERROR_CODES.BAD_INPUT,
    });
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
      throw Object.assign(
        new Error(`debug session has no stopped thread: ${input.sessionId}`),
        { code: ERROR_CODES.BAD_INPUT },
      );
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
