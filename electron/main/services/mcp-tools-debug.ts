import { z } from 'zod';

import {
  MCP_TOOL_DEBUG_CONTINUE,
  MCP_TOOL_DEBUG_DISCONNECT,
  MCP_TOOL_DEBUG_EVALUATE,
  MCP_TOOL_DEBUG_LAUNCH,
  MCP_TOOL_DEBUG_LIST_SESSIONS,
  MCP_TOOL_DEBUG_SET_BREAKPOINT,
  MCP_TOOL_DEBUG_SCOPES,
  MCP_TOOL_DEBUG_STACK,
  MCP_TOOL_DEBUG_STEP_IN,
  MCP_TOOL_DEBUG_STEP_OUT,
  MCP_TOOL_DEBUG_STEP_OVER,
  MCP_TOOL_DEBUG_VARIABLES,
  MCP_TOOL_DEBUG_WAIT_FOR_STOP,
  DEBUG_TOOL_SCHEMAS,
  debugContinueInputSchema,
  debugContinueOutputSchema,
  debugDisconnectInputJsonSchema,
  debugDisconnectInputSchema,
  debugDisconnectOutputSchema,
  debugEvaluateInputJsonSchema,
  debugEvaluateInputSchema,
  debugEvaluateOutputSchema,
  debugLaunchInputJsonSchema,
  debugLaunchInputSchema,
  debugLaunchOutputSchema,
  debugListSessionsInputJsonSchema,
  debugListSessionsInputSchema,
  debugSetBreakpointInputJsonSchema,
  debugSetBreakpointInputSchema,
  debugSetBreakpointOutputSchema,
  debugScopesInputJsonSchema,
  debugScopesInputSchema,
  debugStackInputJsonSchema,
  debugStackInputSchema,
  debugStepInInputSchema,
  debugStepInOutputSchema,
  debugStepOutInputSchema,
  debugStepOutOutputSchema,
  debugStepOverInputSchema,
  debugStepOverOutputSchema,
  debugVariablesInputJsonSchema,
  debugVariablesInputSchema,
  debugWaitForStopInputJsonSchema,
  debugWaitForStopInputSchema,
  debugWaitForStopOutputSchema,
  type DebugEvaluateInput,
  type DebugLaunchInput,
  type DebugSetBreakpointInput,
  type DebugVariablesInput,
  type DebugWaitForStopInput,
} from '../../shared/mcp-debug-schemas';
import { ERROR_CODES } from '../../shared/error-codes';
import type { AnyMcpTool, McpCallCtx, McpToolDef } from './mcp-host.service';
import type {
  DebugCallerContext,
  DebugScope,
  DebugStackFrame,
  DebugVariable,
  LaunchSessionInput,
} from './debug.service';

export type DebugContinueInput = z.infer<typeof debugContinueInputSchema>;
export type DebugContinueOutput = z.infer<typeof debugContinueOutputSchema>;
export type DebugStepOverInput = z.infer<typeof debugStepOverInputSchema>;
export type DebugStepOverOutput = z.infer<typeof debugStepOverOutputSchema>;
export type DebugStepInInput = z.infer<typeof debugStepInInputSchema>;
export type DebugStepInOutput = z.infer<typeof debugStepInOutputSchema>;
export type DebugStepOutInput = z.infer<typeof debugStepOutInputSchema>;
export type DebugStepOutOutput = z.infer<typeof debugStepOutOutputSchema>;
export type DebugStackInput = z.infer<typeof debugStackInputSchema>;
export type DebugScopesInput = z.infer<typeof debugScopesInputSchema>;
export type DebugDisconnectInput = z.infer<typeof debugDisconnectInputSchema>;
export type DebugDisconnectOutput = z.infer<typeof debugDisconnectOutputSchema>;
export type DebugListSessionsInput = z.infer<typeof debugListSessionsInputSchema>;

export interface DebugSessionSummary {
  readonly session_id: string;
  readonly state: string;
  readonly name?: string;
  readonly stopped_reason?: string;
  readonly owner_window_id: number;
}

export interface DebugStackToolOutput {
  readonly frames: readonly DebugStackFrame[];
  readonly total_frames?: number;
}

export interface DebugVariablesToolOutput {
  readonly variables: readonly DebugVariable[];
  readonly truncated: boolean;
  readonly next_start?: number;
}

export interface DebugScopesToolOutput {
  readonly scopes: readonly DebugScope[];
}

export interface DebugListSessionsToolOutput {
  readonly sessions: readonly DebugSessionSummary[];
}

export interface DebugToolService {
  launchSession(
    input: LaunchSessionInput,
    ctx: DebugCallerContext,
  ): Promise<{ session_id: string; state: 'starting' | 'running' | 'stopped' }>;
  setBreakpoints(
    sessionId: string,
    input: { readonly file: string; readonly line: number; readonly column?: number },
  ): Promise<{ verified: boolean; line?: number; message?: string }>;
  waitForStop(
    sessionId: string,
    input: { readonly afterStopSeq?: number; readonly timeoutMs?: number },
  ): Promise<z.infer<typeof debugWaitForStopOutputSchema>>;
  continue(
    sessionId: string,
    input?: { readonly threadId?: number },
  ): Promise<DebugContinueOutput>;
  stepOver(
    sessionId: string,
    input?: { readonly threadId?: number },
  ): Promise<DebugStepOverOutput>;
  stepIn(
    sessionId: string,
    input?: { readonly threadId?: number },
  ): Promise<DebugStepInOutput>;
  stepOut(
    sessionId: string,
    input?: { readonly threadId?: number },
  ): Promise<DebugStepOutOutput>;
  stackTrace(
    sessionId: string,
    input: {
      readonly threadId?: number;
      readonly startFrame?: number;
      readonly levels?: number;
    },
  ): Promise<DebugStackToolOutput>;
  scopes(
    sessionId: string,
    input: { readonly frameId: number },
  ): Promise<DebugScopesToolOutput>;
  variables(
    sessionId: string,
    input: {
      readonly variablesReference: number;
      readonly start?: number;
      readonly count?: number;
      readonly maxDepth?: number;
      readonly maxStringBytes?: number;
    },
  ): Promise<DebugVariablesToolOutput>;
  evaluate(
    sessionId: string,
    input: {
      readonly expression: string;
      readonly frameId?: number;
      readonly context?: 'watch' | 'repl' | 'hover';
      readonly maxResultBytes?: number;
    },
  ): Promise<z.infer<typeof debugEvaluateOutputSchema>>;
  disconnect(
    sessionId: string,
    input?: { readonly terminateDebuggee?: boolean },
  ): Promise<DebugDisconnectOutput>;
  listSessions(): readonly DebugSessionSummary[];
}

export interface DebugToolsDeps {
  readonly service: DebugToolService;
}

export type DebugTool<I, O> = McpToolDef<I, O>;

function inputJsonSchemaFor(name: string): Record<string, unknown> {
  const schema = DEBUG_TOOL_SCHEMAS.find((entry) => entry.name === name);
  if (!schema) throw new Error(`missing debug tool schema: ${name}`);
  return schema.inputJsonSchema;
}

function requireControllerContext(ctx: McpCallCtx): DebugCallerContext {
  if (typeof ctx.callerSubject !== 'string' || ctx.callerSubject.length === 0) {
    throw Object.assign(new Error('debug caller is not authorized'), {
      code: ERROR_CODES.DEBUG_NOT_AUTHORIZED,
    });
  }
  return {
    ownerWindowId: ctx.ownerWindowId,
    controllerToken: ctx.callerSubject,
  };
}

function codedDebugError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalizeDebugError(
  err: unknown,
  fallback?: { readonly code: string; readonly message: string },
): unknown {
  const record =
    err !== null && typeof err === 'object'
      ? (err as { readonly code?: unknown; readonly message?: unknown })
      : null;
  if (typeof record?.code === 'string') return err;
  const message = typeof record?.message === 'string' ? record.message : '';
  if (/^debug session not found\b/i.test(message)) {
    return codedDebugError(
      'debug session not found',
      ERROR_CODES.DEBUG_SESSION_NOT_FOUND,
    );
  }
  if (/debug wait_for_stop timed out/i.test(message)) {
    return codedDebugError(
      'debug wait_for_stop timed out',
      ERROR_CODES.DEBUG_WAIT_TIMEOUT,
    );
  }
  if (fallback) return codedDebugError(fallback.message, fallback.code);
  return err;
}

async function runDebugTool<T>(
  fn: () => T | Promise<T>,
  fallback?: { readonly code: string; readonly message: string },
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw normalizeDebugError(err, fallback);
  }
}

function toLaunchInput(input: DebugLaunchInput): LaunchSessionInput {
  return {
    program: input.program,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    stopOnEntry: input.stop_on_entry,
    ...(input.name !== undefined ? { name: input.name } : {}),
  };
}

export function makeDebugLaunchTool(
  deps: DebugToolsDeps,
): DebugTool<DebugLaunchInput, z.infer<typeof debugLaunchOutputSchema>> {
  return {
    name: MCP_TOOL_DEBUG_LAUNCH,
    description:
      'Launch a Node.js debug session through Continuo. First call asks the user to authorize debug control for this agent. ' +
      'The created debug session is scoped to the current window and this MCP caller only.',
    jsonSchema: debugLaunchInputJsonSchema,
    inputSchema: debugLaunchInputSchema,
    run: (input, ctx) =>
      runDebugTool(
        () =>
          deps.service.launchSession(
            toLaunchInput(input),
            requireControllerContext(ctx),
          ),
        {
          code: ERROR_CODES.DEBUG_ADAPTER_LAUNCH_FAILED,
          message: 'debug adapter launch failed',
        },
      ),
  };
}

export function makeDebugSetBreakpointTool(
  deps: DebugToolsDeps,
): DebugTool<
  DebugSetBreakpointInput,
  z.infer<typeof debugSetBreakpointOutputSchema>
> {
  return {
    name: MCP_TOOL_DEBUG_SET_BREAKPOINT,
    description:
      'Set a source breakpoint in a debug session owned by this MCP caller.',
    jsonSchema: debugSetBreakpointInputJsonSchema,
    inputSchema: debugSetBreakpointInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.setBreakpoints(input.session_id, {
          file: input.file,
          line: input.line,
          ...(input.column !== undefined ? { column: input.column } : {}),
        }),
      ),
  };
}

export function makeDebugWaitForStopTool(
  deps: DebugToolsDeps,
): DebugTool<DebugWaitForStopInput, z.infer<typeof debugWaitForStopOutputSchema>> {
  return {
    name: MCP_TOOL_DEBUG_WAIT_FOR_STOP,
    description:
      'Wait until a debug session owned by this MCP caller stops at a breakpoint, exception, or step.',
    jsonSchema: debugWaitForStopInputJsonSchema,
    inputSchema: debugWaitForStopInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.waitForStop(input.session_id, {
          timeoutMs: input.timeout_ms,
          ...(input.after_stop_seq !== undefined
            ? { afterStopSeq: input.after_stop_seq }
            : {}),
        }),
      ),
  };
}

export function makeDebugContinueTool(
  deps: DebugToolsDeps,
): DebugTool<DebugContinueInput, DebugContinueOutput> {
  return {
    name: MCP_TOOL_DEBUG_CONTINUE,
    description: 'Continue a stopped debug session owned by this MCP caller.',
    jsonSchema: inputJsonSchemaFor(MCP_TOOL_DEBUG_CONTINUE),
    inputSchema: debugContinueInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.continue(input.session_id, {
          ...(input.thread_id !== undefined ? { threadId: input.thread_id } : {}),
        }),
      ),
  };
}

export function makeDebugStepOverTool(
  deps: DebugToolsDeps,
): DebugTool<DebugStepOverInput, DebugStepOverOutput> {
  return {
    name: MCP_TOOL_DEBUG_STEP_OVER,
    description: 'Step over in a stopped debug session owned by this MCP caller.',
    jsonSchema: inputJsonSchemaFor(MCP_TOOL_DEBUG_STEP_OVER),
    inputSchema: debugStepOverInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.stepOver(input.session_id, {
          ...(input.thread_id !== undefined ? { threadId: input.thread_id } : {}),
        }),
      ),
  };
}

export function makeDebugStepInTool(
  deps: DebugToolsDeps,
): DebugTool<DebugStepInInput, DebugStepInOutput> {
  return {
    name: MCP_TOOL_DEBUG_STEP_IN,
    description: 'Step into in a stopped debug session owned by this MCP caller.',
    jsonSchema: inputJsonSchemaFor(MCP_TOOL_DEBUG_STEP_IN),
    inputSchema: debugStepInInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.stepIn(input.session_id, {
          ...(input.thread_id !== undefined ? { threadId: input.thread_id } : {}),
        }),
      ),
  };
}

export function makeDebugStepOutTool(
  deps: DebugToolsDeps,
): DebugTool<DebugStepOutInput, DebugStepOutOutput> {
  return {
    name: MCP_TOOL_DEBUG_STEP_OUT,
    description: 'Step out in a stopped debug session owned by this MCP caller.',
    jsonSchema: inputJsonSchemaFor(MCP_TOOL_DEBUG_STEP_OUT),
    inputSchema: debugStepOutInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.stepOut(input.session_id, {
          ...(input.thread_id !== undefined ? { threadId: input.thread_id } : {}),
        }),
      ),
  };
}

export function makeDebugStackTool(
  deps: DebugToolsDeps,
): DebugTool<DebugStackInput, DebugStackToolOutput> {
  return {
    name: MCP_TOOL_DEBUG_STACK,
    description:
      'Read stack frames from a stopped debug session owned by this MCP caller.',
    jsonSchema: debugStackInputJsonSchema,
    inputSchema: debugStackInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.stackTrace(input.session_id, {
          ...(input.thread_id !== undefined ? { threadId: input.thread_id } : {}),
          startFrame: input.start_frame,
          levels: input.levels,
        }),
      ),
  };
}

export function makeDebugScopesTool(
  deps: DebugToolsDeps,
): DebugTool<DebugScopesInput, DebugScopesToolOutput> {
  return {
    name: MCP_TOOL_DEBUG_SCOPES,
    description:
      'Read the variable scopes (Local/Closure/Global) for a stack frame from debug.stack. Use a returned scope variables_reference with debug.variables to read its variables.',
    jsonSchema: debugScopesInputJsonSchema,
    inputSchema: debugScopesInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.scopes(input.session_id, { frameId: input.frame_id }),
      ),
  };
}

export function makeDebugVariablesTool(
  deps: DebugToolsDeps,
): DebugTool<DebugVariablesInput, DebugVariablesToolOutput> {
  return {
    name: MCP_TOOL_DEBUG_VARIABLES,
    description:
      'Read variables from a stopped debug session owned by this MCP caller.',
    jsonSchema: debugVariablesInputJsonSchema,
    inputSchema: debugVariablesInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.variables(input.session_id, {
          variablesReference: input.variables_reference,
          start: input.start,
          count: input.count,
          maxDepth: input.max_depth,
          maxStringBytes: input.max_string_bytes,
        }),
      ),
  };
}

export function makeDebugEvaluateTool(
  deps: DebugToolsDeps,
): DebugTool<DebugEvaluateInput, z.infer<typeof debugEvaluateOutputSchema>> {
  return {
    name: MCP_TOOL_DEBUG_EVALUATE,
    description:
      'Evaluate an expression in a debug session owned by this MCP caller.',
    jsonSchema: debugEvaluateInputJsonSchema,
    inputSchema: debugEvaluateInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.evaluate(input.session_id, {
          expression: input.expression,
          ...(input.frame_id !== undefined ? { frameId: input.frame_id } : {}),
          context: input.context,
          maxResultBytes: input.max_result_bytes,
        }),
      ),
  };
}

export function makeDebugDisconnectTool(
  deps: DebugToolsDeps,
): DebugTool<DebugDisconnectInput, DebugDisconnectOutput> {
  return {
    name: MCP_TOOL_DEBUG_DISCONNECT,
    description: 'Disconnect and tear down a debug session owned by this MCP caller.',
    jsonSchema: debugDisconnectInputJsonSchema,
    inputSchema: debugDisconnectInputSchema,
    run: (input) =>
      runDebugTool(() =>
        deps.service.disconnect(input.session_id, {
          terminateDebuggee: input.terminate_debuggee,
        }),
      ),
  };
}

export function makeDebugListSessionsTool(
  deps: DebugToolsDeps,
): DebugTool<DebugListSessionsInput, DebugListSessionsToolOutput> {
  return {
    name: MCP_TOOL_DEBUG_LIST_SESSIONS,
    description:
      'List debug sessions in the current Continuo window. Per-session tools only work on sessions created by this MCP caller.',
    jsonSchema: debugListSessionsInputJsonSchema,
    inputSchema: debugListSessionsInputSchema,
    run: (_input, ctx) => ({
      sessions: deps.service
        .listSessions()
        .filter((session) => session.owner_window_id === ctx.ownerWindowId),
    }),
  };
}

export function makeDebugTools(deps: DebugToolsDeps): readonly AnyMcpTool[] {
  return [
    makeDebugLaunchTool(deps),
    makeDebugSetBreakpointTool(deps),
    makeDebugWaitForStopTool(deps),
    makeDebugContinueTool(deps),
    makeDebugStepOverTool(deps),
    makeDebugStepInTool(deps),
    makeDebugStepOutTool(deps),
    makeDebugStackTool(deps),
    makeDebugScopesTool(deps),
    makeDebugVariablesTool(deps),
    makeDebugEvaluateTool(deps),
    makeDebugDisconnectTool(deps),
    makeDebugListSessionsTool(deps),
  ];
}
