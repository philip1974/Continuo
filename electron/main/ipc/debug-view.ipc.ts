import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  safeHandleWithWindow,
} from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  DEBUG_VIEW_CHANNELS,
  type DebugControlInput,
  type DebugGetStackInput,
  type DebugGetVariablesInput,
  type DebugSetUserBreakpointInput,
  type DebugViewEvaluateInput,
} from '../../shared/debug-view-channels';
import type { DebugService } from '../services/debug.service';
import * as debugSessions from '../services/debug-sessions.service';
import { codedError } from '../../shared/error-message';

import {
  debugControlInputSchema,
  debugEvaluateInputSchema,
  debugGetStackInputSchema,
  debugGetVariablesInputSchema,
  debugSetUserBreakpointInputSchema,
  debugSubscribeInputSchema,
} from '../../shared/debug-view-schema';

function requireOwnedDebugSession(sessionId: string, win: BrowserWindow) {
  const session = debugSessions.get(sessionId);
  if (!session || session.ownerWindowId !== win.id) {
    throw codedError(ERROR_CODES.DEBUG_SESSION_NOT_FOUND, 'debug session not found');
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
    return { sessions: service.viewSnapshot(win.id), userBreakpoints: service.userBreakpointSnapshot(win.id) };
  });

  // 用户接管调试会话(调试工具栏 / F5 等按键):只作用于本窗口的会话(含 agent 启动的)。用户在自己的窗口里操作,
  // 不经 agent 授权弹窗;别的窗口的会话与不存在的会话同一错误(不可区分)。
  windowScopedHandle(DEBUG_VIEW_CHANNELS.CONTROL, debugControlInputSchema, async (input: DebugControlInput, win) => {
    requireOwnedDebugSession(input.sessionId, win);
    switch (input.action) {
      case 'continue':
        return service.continue(input.sessionId, {});
      case 'stepOver':
        return service.stepOver(input.sessionId, {});
      case 'stepIn':
        return service.stepIn(input.sessionId, {});
      case 'stepOut':
        return service.stepOut(input.sessionId, {});
      case 'pause':
        return service.pause(input.sessionId);
      case 'stop':
        return service.disconnect(input.sessionId);
    }
  });

  // 编辑器 gutter 切换断点:窗口级用户断点 + 同步到本窗口会话(见 DebugService.setUserBreakpoint)。
  windowScopedHandle(
    DEBUG_VIEW_CHANNELS.SET_USER_BREAKPOINT,
    debugSetUserBreakpointInputSchema,
    (input: DebugSetUserBreakpointInput, win) => service.setUserBreakpoint(win.id, input),
  );

  // 调试控制台求值(context=repl;停住时 renderer 带首帧 id)。
  windowScopedHandle(DEBUG_VIEW_CHANNELS.EVALUATE, debugEvaluateInputSchema, (input: DebugViewEvaluateInput, win) => {
    requireOwnedDebugSession(input.sessionId, win);
    return service.evaluate(input.sessionId, {
      expression: input.expression,
      context: 'repl',
      ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
    });
  });

  // 栈帧 + 首帧作用域一次返回:面板只展示首帧的作用域,首帧 id 是这里刚取到的,不必让 renderer 再带回来问一次。
  // 作用域取不到(该帧已失效等)不影响栈帧展示 → 空数组。
  windowScopedHandle(DEBUG_VIEW_CHANNELS.GET_STACK, debugGetStackInputSchema, async (input: DebugGetStackInput, win) => {
    requireStoppedSession(input.sessionId, win);
    const stack = await service.stackTrace(input.sessionId, {});
    const top = stack.frames[0];
    const scopes = top
      ? await service.scopes(input.sessionId, { frameId: top.id }).then(
          (r) => r.scopes,
          () => [],
        )
      : [];
    return { ...stack, scopes };
  });

  windowScopedHandle(DEBUG_VIEW_CHANNELS.GET_VARIABLES, debugGetVariablesInputSchema, (input: DebugGetVariablesInput, win) => {
    requireStoppedSession(input.sessionId, win);
    return service.variables(input.sessionId, {
      variablesReference: input.variablesReference,
      ...(input.start !== undefined ? { start: input.start } : {}),
    });
  });
}
