// Plugin → MCP Bridge — IPC payload zod schemas。
//
// **改 schema 后必须同步更新 ./plugin-mcp-channels.ts 里手写的对应 type**
// (preload sandbox 不能 import zod,所以纯类型分文件留在 channels.ts)。
//
// 只在 main / renderer 进程使用(不被 preload 引用)。
//
// BDD: src/__tests__/plugin-mcp-ipc-bridge/

import { z } from 'zod';

/** renderer → main: 注册 tool 元数据(run 闭包不跨进程,留 renderer). */
export const RegisterPayloadSchema = z
  .object({
    pluginId: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    /** 任意 JSON object,给 MCP client tools/list 看的 input schema. */
    jsonSchema: z.record(z.unknown()),
  })
  .strict();

/** renderer → main: 摘掉 tool. */
export const UnregisterPayloadSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();

/** main → renderer: 反向调用 tool.run. */
export const InvokePayloadSchema = z
  .object({
    requestId: z.string().min(1),
    name: z.string().min(1),
    /**
     * plugin 自定义 inputSchema,bridge 层不预设形态 — 任意值都接受,
     * 但 key 必须存在(zod 的 z.unknown 会把缺 key 算 optional,refine 兜住).
     */
    input: z.unknown(),
  })
  .strict()
  .refine((data) => 'input' in data, {
    message: 'input is required',
    path: ['input'],
  });

/** renderer → main: invoke 答复(discriminated union by ok). */
export const InvokeReplySchema = z.discriminatedUnion('ok', [
  z
    .object({
      requestId: z.string().min(1),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      requestId: z.string().min(1),
      ok: z.literal(false),
      code: z.string().min(1),
      message: z.string(),
    })
    .strict(),
]);
