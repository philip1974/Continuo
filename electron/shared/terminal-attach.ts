// topic-05: MCP create_session 入参 target 的形态。1 PTY = 1 panel 之后没有消费者(不进会话
// metadata、不广播),create_session 只用本 schema 校验后忽略,保持对 agent 的入参契约。

import { z } from 'zod';

// 边界(E23,E11/E21 同族):panelId/windowId 此前只 .min(1)/.int(),无长度/安全整数/非负边界。
// panelId 限长 256;windowId 非负 + 安全整数(.max MAX_SAFE_INTEGER 挡 ≥2^53 的舍入值,同 E4/E7/E8)。
export const AttachTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('active') }).strict(),
  z
    .object({ kind: z.literal('panel'), panelId: z.string().min(1).max(256) })
    .strict(),
  z
    .object({
      kind: z.literal('window'),
      windowId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);

export type AttachTarget = z.infer<typeof AttachTargetSchema>;
