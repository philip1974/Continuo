// debug 面板 IPC 入参的 zod schema + 类型单一来源(同 terminal-create.ts 的做法):main(debug-view.ipc)用 schema
// 校验,debug-view-channels 以 `import type` + z.infer 派生入参类型(类型导入被擦除,preload 不带 zod)。

import { z } from 'zod';
import { sessionIdSchema } from './mcp-debug-schemas';
import { DEBUG_CONTROL_ACTIONS } from './debug-view-channels';

export const debugSubscribeInputSchema = z.object({}).strict();

// 面板只暴露它实际用到的入参;停住的线程、每页条数 / 展开深度 / 截断等一律走 debug.service 的默认值。
export const debugGetStackInputSchema = z.object({ sessionId: sessionIdSchema }).strict();

export const debugGetVariablesInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    variablesReference: z.number().int().positive(),
    // 「加载更多」:上一页返回的 next_start(同 MCP debug.variables 的 start);缺省从 0 起。
    start: z.number().int().min(0).optional(),
  })
  .strict();

export const debugControlInputSchema = z
  .object({ sessionId: sessionIdSchema, action: z.enum(DEBUG_CONTROL_ACTIONS) })
  .strict();

// file 是编辑器 tab 的绝对路径(main 不读它,只转给 adapter);enabled=false 删除该行(含 adapter 校正到该行的断点)。
export const debugSetUserBreakpointInputSchema = z
  .object({
    file: z.string().min(1).max(4096),
    line: z.number().int().min(1),
    enabled: z.boolean(),
  })
  .strict();

// 调试控制台求值:停住时带首帧 id(在当前帧求值),运行中不带(全局求值)。表达式长度同 MCP debug.evaluate。
export const debugEvaluateInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    expression: z.string().min(1).max(4096),
    frameId: z.number().int().min(0).optional(),
  })
  .strict();
