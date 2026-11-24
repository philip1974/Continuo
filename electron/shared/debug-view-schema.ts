// debug 面板 IPC 入参的 zod schema + 类型单一来源(同 terminal-create.ts 的做法):main(debug-view.ipc)用 schema
// 校验,debug-view-channels 以 `import type` + z.infer 派生入参类型(类型导入被擦除,preload 不带 zod)。

import { z } from 'zod';
import { sessionIdSchema } from './mcp-debug-schemas';

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
