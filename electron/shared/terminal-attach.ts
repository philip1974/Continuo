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
