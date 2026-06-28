import { z } from 'zod';

export const DEBUG_SESSION_ID_MAX = 256;
export const DEBUG_PATH_MAX = 4096;
export const DEBUG_EXPRESSION_MAX = 4096;
export const DEBUG_VARIABLE_COUNT_MAX = 100;
export const DEBUG_VARIABLE_DEPTH_MAX = 5;
export const DEBUG_STRING_BYTES_DEFAULT = 65536;
export const DEBUG_EVALUATE_RESULT_BYTES_MAX = 65536;

export const MCP_TOOL_DEBUG_LAUNCH = 'debug.launch';
export const MCP_TOOL_DEBUG_SET_BREAKPOINT = 'debug.set_breakpoint';
export const MCP_TOOL_DEBUG_WAIT_FOR_STOP = 'debug.wait_for_stop';
export const MCP_TOOL_DEBUG_CONTINUE = 'debug.continue';
export const MCP_TOOL_DEBUG_STEP_OVER = 'debug.step_over';
export const MCP_TOOL_DEBUG_STEP_IN = 'debug.step_in';
export const MCP_TOOL_DEBUG_STEP_OUT = 'debug.step_out';
export const MCP_TOOL_DEBUG_STACK = 'debug.stack';
export const MCP_TOOL_DEBUG_SCOPES = 'debug.scopes';
export const MCP_TOOL_DEBUG_VARIABLES = 'debug.variables';
export const MCP_TOOL_DEBUG_EVALUATE = 'debug.evaluate';
export const MCP_TOOL_DEBUG_DISCONNECT = 'debug.disconnect';
export const MCP_TOOL_DEBUG_LIST_SESSIONS = 'debug.list_sessions';

const sessionIdSchema = z.string().min(1).max(DEBUG_SESSION_ID_MAX);
const pathSchema = z.string().min(1).max(DEBUG_PATH_MAX);
const nonNegativeIntSchema = z.number().int().min(0);
const positiveIntSchema = z.number().int().min(1);
// js-debug 的 Node 线程 id 是 0(DAP threadId 允许 0)。thread_id 用 nonNegative,
// 可选:省略时引擎用 threads 请求解析。历史上误设 min(1) 把合法的 0 拒了。
const threadIdSchema = nonNegativeIntSchema.optional();

const dapVariableSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    type: z.string().optional(),
    variables_reference: z.number().int().min(0).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

const stackFrameSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    source_path: z.string().optional(),
    line: positiveIntSchema,
    column: positiveIntSchema.optional(),
  })
  .strict();

const debugScopeSchema = z
  .object({
    name: z.string(),
    variables_reference: z.number().int().min(0),
    expensive: z.boolean(),
  })
  .strict();

const debugSessionSummarySchema = z
  .object({
    session_id: sessionIdSchema,
    state: z.enum(['starting', 'running', 'stopped', 'terminated']),
    name: z.string().optional(),
    stopped_reason: z.string().optional(),
    owner_window_id: z.number().int().optional(),
  })
  .strict();

const debugEnvEntrySchema = z
  .object({
    name: z.string().min(1).max(256),
    value: z.string().max(4096),
  })
  .strict();

export const debugLaunchInputSchema = z
  .object({
    program: pathSchema,
    cwd: pathSchema.optional(),
    args: z.array(z.string().max(4096)).max(128).optional(),
    env: z.array(debugEnvEntrySchema).max(128).optional(),
    stop_on_entry: z.boolean().optional().default(false),
    name: z.string().min(1).max(128).optional(),
  })
  .strict();

export const debugLaunchOutputSchema = z
  .object({
    session_id: sessionIdSchema,
    state: z.enum(['starting', 'running', 'stopped']),
  })
  .strict();

export const debugSetBreakpointInputSchema = z
  .object({
    session_id: sessionIdSchema,
    file: pathSchema,
    line: positiveIntSchema,
    column: positiveIntSchema.optional(),
    // 预留给 DAP 条件断点/日志断点；当前 MVP 服务层不实现，schema 阶段显式拒绝，避免静默误以为已生效。
    condition: z.string().min(1).max(4096).optional(),
    logMessage: z.string().min(1).max(4096).optional(),
    hitCondition: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const field of ['condition', 'logMessage', 'hitCondition'] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is reserved but not supported in the MVP`,
        });
      }
    }
  });

export const debugSetBreakpointOutputSchema = z
  .object({
    breakpoint_id: z.string().optional(),
    verified: z.boolean(),
    line: positiveIntSchema.optional(),
    message: z.string().optional(),
  })
  .strict();

export const debugWaitForStopInputSchema = z
  .object({
    session_id: sessionIdSchema,
    timeout_ms: z.number().int().min(1).max(120_000).default(30_000),
    after_stop_seq: nonNegativeIntSchema.optional(),
  })
  .strict();

export const debugWaitForStopOutputSchema = z
  .object({
    session_id: sessionIdSchema,
    stop_seq: nonNegativeIntSchema,
    reason: z.string(),
    thread_id: nonNegativeIntSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

const debugThreadControlInputSchema = z
  .object({
    session_id: sessionIdSchema,
    thread_id: threadIdSchema,
  })
  .strict();

const debugThreadControlOutputSchema = z
  .object({
    continued: z.boolean(),
    all_threads_continued: z.boolean().optional(),
  })
  .strict();

export const debugContinueInputSchema = debugThreadControlInputSchema;
export const debugContinueOutputSchema = debugThreadControlOutputSchema;
export const debugStepOverInputSchema = debugThreadControlInputSchema;
export const debugStepOverOutputSchema = debugThreadControlOutputSchema;
export const debugStepInInputSchema = debugThreadControlInputSchema;
export const debugStepInOutputSchema = debugThreadControlOutputSchema;
export const debugStepOutInputSchema = debugThreadControlInputSchema;
export const debugStepOutOutputSchema = debugThreadControlOutputSchema;

export const debugStackInputSchema = z
  .object({
    session_id: sessionIdSchema,
    // thread_id 可选:省略时引擎用 threads 请求解析当前活跃线程。
    // (js-debug 的 stopped 事件可能报 threadId:0,直接透传会撞 min(1)。)
    thread_id: threadIdSchema,
    start_frame: nonNegativeIntSchema.default(0),
    levels: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const debugStackOutputSchema = z
  .object({
    frames: z.array(stackFrameSchema).max(100),
    total_frames: nonNegativeIntSchema.optional(),
  })
  .strict();

export const debugScopesInputSchema = z
  .object({
    session_id: sessionIdSchema,
    frame_id: nonNegativeIntSchema,
  })
  .strict();

export const debugScopesOutputSchema = z
  .object({
    scopes: z.array(debugScopeSchema).max(50),
  })
  .strict();

export const debugVariablesInputSchema = z
  .object({
    session_id: sessionIdSchema,
    variables_reference: positiveIntSchema,
    start: nonNegativeIntSchema.default(0),
    count: z.number().int().min(1).max(DEBUG_VARIABLE_COUNT_MAX).default(100),
    max_depth: z
      .number()
      .int()
      .min(0)
      .max(DEBUG_VARIABLE_DEPTH_MAX)
      .default(1),
    max_string_bytes: z
      .number()
      .int()
      .min(1)
      .max(DEBUG_STRING_BYTES_DEFAULT)
      .default(DEBUG_STRING_BYTES_DEFAULT),
  })
  .strict();

export const debugVariablesOutputSchema = z
  .object({
    variables: z.array(dapVariableSchema).max(DEBUG_VARIABLE_COUNT_MAX),
    truncated: z.boolean(),
    next_start: nonNegativeIntSchema.optional(),
  })
  .strict();

export const debugEvaluateInputSchema = z
  .object({
    session_id: sessionIdSchema,
    expression: z.string().min(1).max(DEBUG_EXPRESSION_MAX),
    frame_id: z.number().int().optional(),
    context: z.enum(['watch', 'repl', 'hover']).default('watch'),
    max_result_bytes: z
      .number()
      .int()
      .min(1)
      .max(DEBUG_EVALUATE_RESULT_BYTES_MAX)
      .default(DEBUG_EVALUATE_RESULT_BYTES_MAX),
  })
  .strict();

export const debugEvaluateOutputSchema = z
  .object({
    result: z.string(),
    type: z.string().optional(),
    variables_reference: z.number().int().min(0).optional(),
    truncated: z.boolean(),
  })
  .strict();

export const debugDisconnectInputSchema = z
  .object({
    session_id: sessionIdSchema,
    terminate_debuggee: z.boolean().default(true),
  })
  .strict();

export const debugDisconnectOutputSchema = z
  .object({
    disconnected: z.boolean(),
  })
  .strict();

export const debugListSessionsInputSchema = z.object({}).strict();
export const debugListSessionsOutputSchema = z
  .object({
    sessions: z.array(debugSessionSummarySchema).max(100),
  })
  .strict();

export type DebugLaunchInput = z.infer<typeof debugLaunchInputSchema>;
export type DebugLaunchOutput = z.infer<typeof debugLaunchOutputSchema>;
export type DebugSetBreakpointInput = z.infer<
  typeof debugSetBreakpointInputSchema
>;
export type DebugSetBreakpointOutput = z.infer<
  typeof debugSetBreakpointOutputSchema
>;
export type DebugWaitForStopInput = z.infer<typeof debugWaitForStopInputSchema>;
export type DebugWaitForStopOutput = z.infer<
  typeof debugWaitForStopOutputSchema
>;
export type DebugVariablesInput = z.infer<typeof debugVariablesInputSchema>;
export type DebugVariablesOutput = z.infer<typeof debugVariablesOutputSchema>;
export type DebugEvaluateInput = z.infer<typeof debugEvaluateInputSchema>;
export type DebugEvaluateOutput = z.infer<typeof debugEvaluateOutputSchema>;
export type DebugScopesInput = z.infer<typeof debugScopesInputSchema>;
export type DebugScopesOutput = z.infer<typeof debugScopesOutputSchema>;

type JsonSchema = Record<string, unknown>;

const stringSchema = (maxLength?: number): JsonSchema => ({
  type: 'string',
  ...(maxLength ? { maxLength } : {}),
});
const intSchema = (minimum = 0, maximum?: number): JsonSchema => ({
  type: 'integer',
  minimum,
  ...(maximum !== undefined ? { maximum } : {}),
});
const boolSchema = (): JsonSchema => ({ type: 'boolean' });
const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const arraySchema = (items: JsonSchema, maxItems?: number): JsonSchema => ({
  type: 'array',
  items,
  ...(maxItems !== undefined ? { maxItems } : {}),
});

const sessionIdJson = stringSchema(DEBUG_SESSION_ID_MAX);
const pathJson = stringSchema(DEBUG_PATH_MAX);
const threadControlInputJson = objectSchema(
  {
    session_id: sessionIdJson,
    thread_id: {
      ...intSchema(0),
      description:
        'Optional. js-debug reports the Node thread id as 0 (valid). Omit to let the engine resolve it.',
    },
  },
  ['session_id'],
);
const threadControlOutputJson = objectSchema(
  {
    continued: boolSchema(),
    all_threads_continued: boolSchema(),
  },
  ['continued'],
);
const frameJson = objectSchema(
  {
    id: intSchema(0),
    name: stringSchema(),
    source_path: stringSchema(DEBUG_PATH_MAX),
    line: intSchema(1),
    column: intSchema(1),
  },
  ['id', 'name', 'line'],
);
const variableJson = objectSchema(
  {
    name: stringSchema(),
    value: stringSchema(),
    type: stringSchema(),
    variables_reference: intSchema(0),
    truncated: boolSchema(),
  },
  ['name', 'value'],
);
const sessionSummaryJson = objectSchema(
  {
    session_id: sessionIdJson,
    state: { type: 'string', enum: ['starting', 'running', 'stopped', 'terminated'] },
    name: stringSchema(128),
    stopped_reason: stringSchema(),
    owner_window_id: intSchema(0),
  },
  ['session_id', 'state'],
);
const envEntryJson = objectSchema(
  {
    name: stringSchema(256),
    value: stringSchema(4096),
  },
  ['name', 'value'],
);

export const debugLaunchInputJsonSchema = objectSchema(
  {
    program: pathJson,
    cwd: pathJson,
    args: arraySchema(stringSchema(4096), 128),
    env: arraySchema(envEntryJson, 128),
    stop_on_entry: boolSchema(),
    name: stringSchema(128),
  },
  ['program'],
);
export const debugLaunchOutputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    state: { type: 'string', enum: ['starting', 'running', 'stopped'] },
  },
  ['session_id', 'state'],
);
export const debugSetBreakpointInputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    file: pathJson,
    line: intSchema(1),
    column: intSchema(1),
    condition: {
      ...stringSchema(4096),
      description: 'Reserved for future conditional breakpoints; rejected in the MVP.',
    },
    logMessage: {
      ...stringSchema(4096),
      description: 'Reserved for future logpoints; rejected in the MVP.',
    },
    hitCondition: {
      ...stringSchema(256),
      description: 'Reserved for future hit-count breakpoints; rejected in the MVP.',
    },
  },
  ['session_id', 'file', 'line'],
);
export const debugSetBreakpointOutputJsonSchema = objectSchema(
  {
    breakpoint_id: stringSchema(),
    verified: boolSchema(),
    line: intSchema(1),
    message: stringSchema(),
  },
  ['verified'],
);
export const debugWaitForStopInputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    timeout_ms: intSchema(1, 120_000),
    after_stop_seq: intSchema(0),
  },
  ['session_id'],
);
export const debugWaitForStopOutputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    stop_seq: intSchema(0),
    reason: stringSchema(),
    thread_id: intSchema(0),
    description: stringSchema(),
  },
  ['session_id', 'stop_seq', 'reason'],
);
export const debugStackInputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    thread_id: {
      ...intSchema(0),
      description:
        'Optional. Omit to let the engine resolve the active thread (recommended; js-debug reports the Node thread id as 0).',
    },
    start_frame: intSchema(0),
    levels: intSchema(1, 100),
  },
  ['session_id'],
);
export const debugStackOutputJsonSchema = objectSchema(
  {
    frames: arraySchema(frameJson, 100),
    total_frames: intSchema(0),
  },
  ['frames'],
);
const scopeJson = objectSchema(
  {
    name: stringSchema(),
    variables_reference: intSchema(0),
    expensive: boolSchema(),
  },
  ['name', 'variables_reference', 'expensive'],
);
export const debugScopesInputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    frame_id: {
      ...intSchema(0),
      description: 'A frame id from debug.stack. Resolve scopes here, then read debug.variables with a scope variables_reference.',
    },
  },
  ['session_id', 'frame_id'],
);
export const debugScopesOutputJsonSchema = objectSchema(
  {
    scopes: arraySchema(scopeJson, 50),
  },
  ['scopes'],
);
export const debugVariablesInputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    variables_reference: intSchema(1),
    start: intSchema(0),
    count: intSchema(1, DEBUG_VARIABLE_COUNT_MAX),
    max_depth: intSchema(0, DEBUG_VARIABLE_DEPTH_MAX),
    max_string_bytes: intSchema(1, DEBUG_STRING_BYTES_DEFAULT),
  },
  ['session_id', 'variables_reference'],
);
export const debugVariablesOutputJsonSchema = objectSchema(
  {
    variables: arraySchema(variableJson, DEBUG_VARIABLE_COUNT_MAX),
    truncated: boolSchema(),
    next_start: intSchema(0),
  },
  ['variables', 'truncated'],
);
export const debugEvaluateInputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    expression: stringSchema(DEBUG_EXPRESSION_MAX),
    frame_id: intSchema(0),
    context: { type: 'string', enum: ['watch', 'repl', 'hover'], default: 'watch' },
    max_result_bytes: intSchema(1, DEBUG_EVALUATE_RESULT_BYTES_MAX),
  },
  ['session_id', 'expression'],
);
export const debugEvaluateOutputJsonSchema = objectSchema(
  {
    result: stringSchema(),
    type: stringSchema(),
    variables_reference: intSchema(0),
    truncated: boolSchema(),
  },
  ['result', 'truncated'],
);
export const debugDisconnectInputJsonSchema = objectSchema(
  {
    session_id: sessionIdJson,
    terminate_debuggee: boolSchema(),
  },
  ['session_id'],
);
export const debugDisconnectOutputJsonSchema = objectSchema(
  {
    disconnected: boolSchema(),
  },
  ['disconnected'],
);
export const debugListSessionsInputJsonSchema = objectSchema({});
export const debugListSessionsOutputJsonSchema = objectSchema(
  {
    sessions: arraySchema(sessionSummaryJson, 100),
  },
  ['sessions'],
);

export const DEBUG_TOOL_SCHEMAS = [
  {
    name: MCP_TOOL_DEBUG_LAUNCH,
    inputSchema: debugLaunchInputSchema,
    outputSchema: debugLaunchOutputSchema,
    inputJsonSchema: debugLaunchInputJsonSchema,
    outputJsonSchema: debugLaunchOutputJsonSchema,
  },
  {
    name: MCP_TOOL_DEBUG_SET_BREAKPOINT,
    inputSchema: debugSetBreakpointInputSchema,
    outputSchema: debugSetBreakpointOutputSchema,
    inputJsonSchema: debugSetBreakpointInputJsonSchema,
    outputJsonSchema: debugSetBreakpointOutputJsonSchema,
  },
  {
    name: MCP_TOOL_DEBUG_WAIT_FOR_STOP,
    inputSchema: debugWaitForStopInputSchema,
    outputSchema: debugWaitForStopOutputSchema,
    inputJsonSchema: debugWaitForStopInputJsonSchema,
    outputJsonSchema: debugWaitForStopOutputJsonSchema,
  },
  {
    name: MCP_TOOL_DEBUG_CONTINUE,
    inputSchema: debugContinueInputSchema,
    outputSchema: debugContinueOutputSchema,
    inputJsonSchema: threadControlInputJson,
    outputJsonSchema: threadControlOutputJson,
  },
  {
    name: MCP_TOOL_DEBUG_STEP_OVER,
    inputSchema: debugStepOverInputSchema,
    outputSchema: debugStepOverOutputSchema,
    inputJsonSchema: threadControlInputJson,
    outputJsonSchema: threadControlOutputJson,
  },
  {
    name: MCP_TOOL_DEBUG_STEP_IN,
    inputSchema: debugStepInInputSchema,
    outputSchema: debugStepInOutputSchema,
    inputJsonSchema: threadControlInputJson,
    outputJsonSchema: threadControlOutputJson,
  },
  {
    name: MCP_TOOL_DEBUG_STEP_OUT,
    inputSchema: debugStepOutInputSchema,
    outputSchema: debugStepOutOutputSchema,
    inputJsonSchema: threadControlInputJson,
    outputJsonSchema: threadControlOutputJson,
  },
  {
    name: MCP_TOOL_DEBUG_STACK,
    inputSchema: debugStackInputSchema,
    outputSchema: debugStackOutputSchema,
    inputJsonSchema: debugStackInputJsonSchema,
    outputJsonSchema: debugStackOutputJsonSchema,
  },
  {
    name: MCP_TOOL_DEBUG_SCOPES,
    inputSchema: debugScopesInputSchema,
    outputSchema: debugScopesOutputSchema,
    inputJsonSchema: debugScopesInputJsonSchema,
    outputJsonSchema: debugScopesOutputJsonSchema,
  },
  {
    name: MCP_TOOL_DEBUG_VARIABLES,
    inputSchema: debugVariablesInputSchema,
    outputSchema: debugVariablesOutputSchema,
    inputJsonSchema: debugVariablesInputJsonSchema,
    outputJsonSchema: debugVariablesOutputJsonSchema,
  },
  {
    name: MCP_TOOL_DEBUG_EVALUATE,
    inputSchema: debugEvaluateInputSchema,
    outputSchema: debugEvaluateOutputSchema,
    inputJsonSchema: debugEvaluateInputJsonSchema,
    outputJsonSchema: debugEvaluateOutputJsonSchema,
  },
  {
    name: MCP_TOOL_DEBUG_DISCONNECT,
    inputSchema: debugDisconnectInputSchema,
    outputSchema: debugDisconnectOutputSchema,
    inputJsonSchema: debugDisconnectInputJsonSchema,
    outputJsonSchema: debugDisconnectOutputJsonSchema,
  },
  {
    name: MCP_TOOL_DEBUG_LIST_SESSIONS,
    inputSchema: debugListSessionsInputSchema,
    outputSchema: debugListSessionsOutputSchema,
    inputJsonSchema: debugListSessionsInputJsonSchema,
    outputJsonSchema: debugListSessionsOutputJsonSchema,
  },
] as const;
