// debug 面板 IPC 入参的 zod schema + 类型单一来源(同 terminal-create.ts 的做法):main(debug-view.ipc)用 schema
// 校验,debug-view-channels 以 `import type` + z.infer 派生入参类型(类型导入被擦除,preload 不带 zod)。

import { z } from 'zod';
import { sessionIdSchema } from './mcp-debug-schemas';

export const debugSubscribeInputSchema = z.object({}).strict();

// 面板只暴露它实际用到的入参;停住的线程、分页 / 展开深度 / 截断等一律走 debug.service 的默认值。
export const debugGetStackInputSchema = z.object({ sessionId: sessionIdSchema }).strict();

export const debugGetVariablesInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    variablesReference: z.number().int().positive(),
  })
  .strict();
