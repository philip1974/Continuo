import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { defaultIsTrustedFrame, processIpcCall } from '../safe-handle';
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

function senderWindowOrThrow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    throw Object.assign(new Error('no browser window'), {
      code: ERROR_CODES.NO_WINDOW,
    });
  }
  return win;
}

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

  ipcMain.handle(
    DEBUG_VIEW_CHANNELS.SUBSCRIBE,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        debugSubscribeInputSchema,
        async () => {
          const win = senderWindowOrThrow(event);
          return {
            sessions: service
              .listSessions()
              .filter((session) => session.owner_window_id === win.id),
          };
        },
        raw,
        event.senderFrame,
        trusted,
      ),
  );

  ipcMain.handle(
    DEBUG_VIEW_CHANNELS.GET_STACK,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        debugGetStackInputSchema,
        async (input: DebugGetStackInput) => {
          const win = senderWindowOrThrow(event);
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
        },
        raw,
        event.senderFrame,
        trusted,
      ),
  );

  ipcMain.handle(
    DEBUG_VIEW_CHANNELS.GET_SCOPES,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        debugGetScopesInputSchema,
        async (input: DebugGetScopesInput) => {
          const win = senderWindowOrThrow(event);
          requireStoppedSession(input.sessionId, win);
          return service.scopes(input.sessionId, { frameId: input.frameId });
        },
        raw,
        event.senderFrame,
        trusted,
      ),
  );

  ipcMain.handle(
    DEBUG_VIEW_CHANNELS.GET_VARIABLES,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        debugGetVariablesInputSchema,
        async (input: DebugGetVariablesInput) => {
          const win = senderWindowOrThrow(event);
          requireStoppedSession(input.sessionId, win);
          return service.variables(input.sessionId, {
            variablesReference: input.variablesReference,
            start: input.start,
            count: input.count,
            maxDepth: input.maxDepth,
            maxStringBytes: input.maxStringBytes,
          });
        },
        raw,
        event.senderFrame,
        trusted,
      ),
  );
}
