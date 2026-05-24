// topic-05: terminal create 的 attach 目标 — agent 通过 MCP create_session
// 可指定让 renderer 把新 PTY 接管到哪个 panel/window。type 与 zod schema
// 单源,main service 用 type,main IPC 用 schema(z.infer 等价于 type)。

import { z } from 'zod';

export const AttachTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('active') }).strict(),
  z.object({ kind: z.literal('panel'), panelId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('window'), windowId: z.number().int() }).strict(),
]);

export type AttachTarget = z.infer<typeof AttachTargetSchema>;
