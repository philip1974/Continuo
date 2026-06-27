// topic-05: terminal create 的 attach 目标 — agent 通过 MCP create_session
// 可指定让 renderer 把新 PTY 接管到哪个 panel/window。type 与 zod schema
// 单源,main service 用 type,main IPC 用 schema(z.infer 等价于 type)。

import { z } from 'zod';

// 边界(E23,E11/E21 同族):panelId/windowId 此前只 .min(1)/.int(),无长度/安全整数/非负边界。
// 被 TerminalCreateInputSchema 复用 → MCP create_session / renderer 可传超长 panelId 或不安全巨大
// windowId,该对象进 terminal session metadata 并随 sessions_changed 广播到所有 renderer,造成
// IPC/UI 膨胀,或窗口匹配逻辑在不安全整数上行为不可预测。panelId 限长 256;windowId 非负 + 安全
// 整数(.max MAX_SAFE_INTEGER 挡 ≥2^53 的舍入值,同 E4/E7/E8)。
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

// 可维护性 M23:renderer tryAttachExisting 失败反向通知 main 的 reason 枚举单一来源
//(main IPC 用 z.enum,preload API 用派生类型),避免 main/preload 契约漂移。
export const TERMINAL_ATTACH_REJECT_REASONS = [
  'limit',
  'duplicate',
  'not-hydrated',
  'no-target',
] as const;

export type TerminalAttachRejectReason =
  (typeof TERMINAL_ATTACH_REJECT_REASONS)[number];
