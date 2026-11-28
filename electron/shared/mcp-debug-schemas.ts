import { z } from 'zod';
import { sessionIdSchema } from './session-id-schema';

const DEBUG_PATH_MAX = 4096;
const DEBUG_EXPRESSION_MAX = 4096;
const DEBUG_VARIABLE_COUNT_MAX = 100;
/** 单次 stackTrace 取的帧数上限(MCP debug.stack 入参上限;Debug 面板不传 levels,走默认帧数)。 */
const DEBUG_STACK_LEVELS_MAX = 100;
const DEBUG_VARIABLE_DEPTH_MAX = 5;
export const DEBUG_STRING_BYTES_DEFAULT = 65536;
export const DEBUG_EVALUATE_RESULT_BYTES_MAX = 65536;
// 未给值时的默认:MCP 工具经 zod .default 取,debug 面板 IPC(只传必需入参)经 DebugService 取 —— 两边共用这几个常量。
export const DEBUG_STACK_LEVELS_DEFAULT = 20;
export const DEBUG_VARIABLE_COUNT_DEFAULT = 100;
export const DEBUG_VARIABLE_DEPTH_DEFAULT = 1;

export const MCP_TOOL_DEBUG_LAUNCH = 'debug.launch';
/**
 * debug 工具的授权 method 名(main mcp-debug-host 门控发出、renderer 授权弹窗按它取文案):launch 单列,
 * 其余 debug 工具统一为一个 method。
 */
export const DEBUG_AUTH_METHOD_LAUNCH = MCP_TOOL_DEBUG_LAUNCH;
export const DEBUG_AUTH_METHOD_CONTROL = 'debug.*';
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
export const MCP_TOOL_DEBUG_READ_OUTPUT = 'debug.read_output';
/** debug.read_output 单次返回的输出字节上限(默认 / 最大)。 */
export const DEBUG_READ_OUTPUT_BYTES_DEFAULT = 64 * 1024;
export const DEBUG_READ_OUTPUT_BYTES_MAX = 1024 * 1024;

/** debug session id(MCP 工具入参与 Debug 面板 IPC 入参共用;与 terminal / hook-bridge 同一共享常量)。 */
export { sessionIdSchema };
const pathSchema = z.string().min(1).max(DEBUG_PATH_MAX);
const nonNegativeIntSchema = z.number().int().min(0);
const positiveIntSchema = z.number().int().min(1);
// js-debug 的 Node 线程 id 是 0(DAP threadId 允许 0)。thread_id 用 nonNegative,
// 可选:省略时引擎取最近停点的线程,无停点记录再发 threads 请求。历史上误设 min(1) 把合法的 0 拒了。
const threadIdSchema = nonNegativeIntSchema.optional();

/**
 * launch 的 env 禁止的变量(大小写不敏感比较,覆盖 Windows):它们让 Node / 动态链接器 / OpenSSL / glibc 在目标程序之前
 * 加载额外代码(NODE_OPTIONS=--require=/tmp/x.js、DYLD_INSERT_LIBRARIES、OPENSSL_CONF 指向的 engine/provider、
 * GCONV_PATH 下的 .so 等),绕过 program / cwd 的工作区闸。动态链接器与 OpenSSL 的变量族会随版本增加,按前缀整族拒绝,
 * 不逐个列名(逐个列名曾漏 DYLD_VERSIONED_* / OPENSSL_CONF 等)。
 */
const DEBUG_LAUNCH_FORBIDDEN_ENV_PREFIXES = ['DYLD_', 'LD_', 'OPENSSL_'] as const;
const DEBUG_LAUNCH_FORBIDDEN_ENV = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'GCONV_PATH',
] as const;

/** env 变量名是否命中禁用规则(前缀 + 精确名,大小写不敏感)。 */
export function isDebugLaunchEnvForbidden(name: string): boolean {
  // 合法变量名不含 `=` / NUL:POSIX 按第一个 `=` 切分,`NODE_OPTIONS=--import` 会生成 NODE_OPTIONS 变量,
  // 绕过下面的精确名 / 前缀比较。一律视为禁用。
  if (name.includes('=') || name.includes('\0')) return true;
  const upper = name.toUpperCase();
  return (
    (DEBUG_LAUNCH_FORBIDDEN_ENV as readonly string[]).includes(upper) ||
    DEBUG_LAUNCH_FORBIDDEN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

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
    env: z
      .array(debugEnvEntrySchema)
      .max(128)
      .optional()
      .describe(
        `Extra environment variables. Variables that make Node, the dynamic linker or OpenSSL load extra code are rejected (case-insensitive): any name starting with ${DEBUG_LAUNCH_FORBIDDEN_ENV_PREFIXES.map((p) => `${p}*`).join(', ')}, plus ${DEBUG_LAUNCH_FORBIDDEN_ENV.join(', ')}. Ordinary variables such as NODE_ENV are passed through. The Node.js runtime is resolved by Continuo, not from env PATH.`,
      ),
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
    condition: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('Reserved for future conditional breakpoints; rejected in the MVP.'),
    logMessage: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('Reserved for future logpoints; rejected in the MVP.'),
    hitCondition: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('Reserved for future hit-count breakpoints; rejected in the MVP.'),
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
    thread_id: threadIdSchema.describe(
      'Optional. js-debug reports the Node thread id as 0 (valid). Omit to let the engine resolve it.',
    ),
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
    // thread_id 可选:省略时引擎取最近停点的线程,无停点记录再发 threads 请求(0 合法,直接透传)。
    thread_id: threadIdSchema.describe(
      'Optional. Omit to let the engine resolve the active thread (recommended; js-debug reports the Node thread id as 0).',
    ),
    start_frame: nonNegativeIntSchema.default(0),
    levels: z.number().int().min(1).max(DEBUG_STACK_LEVELS_MAX).default(DEBUG_STACK_LEVELS_DEFAULT),
  })
  .strict();

export const debugScopesInputSchema = z
  .object({
    session_id: sessionIdSchema,
    frame_id: nonNegativeIntSchema.describe(
      'A frame id from debug.stack. Resolve scopes here, then read debug.variables with a scope variables_reference.',
    ),
  })
  .strict();

export const debugVariablesInputSchema = z
  .object({
    session_id: sessionIdSchema,
    variables_reference: positiveIntSchema,
    start: nonNegativeIntSchema.default(0),
    count: z.number().int().min(1).max(DEBUG_VARIABLE_COUNT_MAX).default(DEBUG_VARIABLE_COUNT_DEFAULT),
    max_depth: z
      .number()
      .int()
      .min(0)
      .max(DEBUG_VARIABLE_DEPTH_MAX)
      .default(DEBUG_VARIABLE_DEPTH_DEFAULT),
    max_string_bytes: z
      .number()
      .int()
      .min(1)
      .max(DEBUG_STRING_BYTES_DEFAULT)
      .default(DEBUG_STRING_BYTES_DEFAULT),
  })
  .strict();

export const debugEvaluateInputSchema = z
  .object({
    session_id: sessionIdSchema,
    expression: z.string().min(1).max(DEBUG_EXPRESSION_MAX),
    // DAP frameId 非负(与 scopes 的 frame_id 同一边界);此前 z.number().int() 放过负数,与对外 schema 的 minimum 0 不一致。
    frame_id: nonNegativeIntSchema.optional(),
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

// 会话都由 Continuo launch,teardown 按 adapter 进程组整组回收;「只断开、让 debuggee 继续跑」会留下
// Continuo 管不到的孤儿进程,不支持。false 显式拒绝(此前被静默忽略、照样终止)。派生出的 JSON schema 为 const:true。
const DEBUG_DISCONNECT_TERMINATE_ONLY_MESSAGE =
  'terminate_debuggee=false is not supported: Continuo always terminates the launched debuggee on disconnect';

export const debugDisconnectInputSchema = z
  .object({
    session_id: sessionIdSchema,
    terminate_debuggee: z
      .literal(true, { error: DEBUG_DISCONNECT_TERMINATE_ONLY_MESSAGE })
      .default(true)
      .describe(
        'Optional; only true is accepted. Disconnect always terminates the launched debuggee (and its process group).',
      ),
  })
  .strict();

export const debugDisconnectOutputSchema = z
  .object({
    disconnected: z.boolean(),
  })
  .strict();

export const debugListSessionsInputSchema = z.object({}).strict();

export const debugReadOutputInputSchema = z
  .object({
    session_id: sessionIdSchema,
    since_seq: nonNegativeIntSchema
      .default(0)
      .describe('Incremental cursor: pass next_seq from the previous read. Default 0 (from the oldest retained entry).'),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(DEBUG_READ_OUTPUT_BYTES_MAX)
      .default(DEBUG_READ_OUTPUT_BYTES_DEFAULT)
      .describe('Upper bound on the total output text returned (UTF-8 bytes); at least one entry is returned when available.'),
  })
  .strict();

export const debugReadOutputOutputSchema = z
  .object({
    entries: z.array(
      z
        .object({
          seq: nonNegativeIntSchema,
          category: z.string(),
          output: z.string(),
        })
        .strict(),
    ),
    next_seq: nonNegativeIntSchema,
    truncated: z.boolean(),
    has_more: z.boolean(),
  })
  .strict();
export type DebugLaunchInput = z.infer<typeof debugLaunchInputSchema>;
export type DebugSetBreakpointInput = z.infer<
  typeof debugSetBreakpointInputSchema
>;
export type DebugWaitForStopInput = z.infer<typeof debugWaitForStopInputSchema>;
export type DebugVariablesInput = z.infer<typeof debugVariablesInputSchema>;
export type DebugEvaluateInput = z.infer<typeof debugEvaluateInputSchema>;
export type DebugScopesInput = z.infer<typeof debugScopesInputSchema>;
export type DebugReadOutputInput = z.infer<typeof debugReadOutputInputSchema>;
export type DebugReadOutputOutput = z.infer<typeof debugReadOutputOutputSchema>;

type JsonSchema = Record<string, unknown>;

/** `.int()` 自带的安全整数上下界:派生时会写进 minimum / maximum,对外不宣告(手写版也从未宣告)。 */
function stripSafeIntegerBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripSafeIntegerBounds(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as JsonSchema;
  if (record.maximum === Number.MAX_SAFE_INTEGER) delete record.maximum;
  if (record.minimum === Number.MIN_SAFE_INTEGER) delete record.minimum;
  for (const value of Object.values(record)) stripSafeIntegerBounds(value);
}

/**
 * MCP tools/list 对外的入参 JSON schema:从运行时 zod 派生(io:'input' —— 带 .default() 的字段非必填并附 default),
 * 不再手写第二份(手写版曾漏 minLength、evaluate frame_id 下界与 zod 不一致)。后处理只做两件事:
 * 去掉 `$schema`(MCP inputSchema 惯例不带,与 terminal 工具一致),去掉 `.int()` 的安全整数默认边界。
 * `.strict()` 派生为 additionalProperties:false;`.superRefine` 的拒绝规则不进 JSON schema(靠字段 description 说明)。
 */
function toAdvertisedJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _omit, ...json } = z.toJSONSchema(schema, { io: 'input' }) as JsonSchema;
  stripSafeIntegerBounds(json);
  return json;
}

/** continue / step_over / step_in / step_out 共用的入参 JSON schema。 */
export const debugThreadControlInputJsonSchema = toAdvertisedJsonSchema(debugThreadControlInputSchema);
export const debugLaunchInputJsonSchema = toAdvertisedJsonSchema(debugLaunchInputSchema);
export const debugSetBreakpointInputJsonSchema = toAdvertisedJsonSchema(debugSetBreakpointInputSchema);
export const debugWaitForStopInputJsonSchema = toAdvertisedJsonSchema(debugWaitForStopInputSchema);
export const debugStackInputJsonSchema = toAdvertisedJsonSchema(debugStackInputSchema);
export const debugScopesInputJsonSchema = toAdvertisedJsonSchema(debugScopesInputSchema);
export const debugVariablesInputJsonSchema = toAdvertisedJsonSchema(debugVariablesInputSchema);
export const debugEvaluateInputJsonSchema = toAdvertisedJsonSchema(debugEvaluateInputSchema);
export const debugDisconnectInputJsonSchema = toAdvertisedJsonSchema(debugDisconnectInputSchema);
export const debugListSessionsInputJsonSchema = toAdvertisedJsonSchema(debugListSessionsInputSchema);
export const debugReadOutputInputJsonSchema = toAdvertisedJsonSchema(debugReadOutputInputSchema);
