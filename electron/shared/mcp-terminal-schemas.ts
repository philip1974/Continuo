// Agent Terminal MCP — tool schemas(Phase 1 仅 list_sessions)。
// schemas 跨 main(校验输入)与 spec(契约断言)共享。
//
// BDD: src/__tests__/agent-terminal-mcp-list-sessions/

import { z } from 'zod';

// ── tool 名常量 ────────────────────────────────────────────────

export const MCP_TOOL_LIST_SESSIONS = 'terminal.list_sessions';

// ── list_sessions ──────────────────────────────────────────────

/** 空对象,严格(任何额外字段拒). */
export const listSessionsInputSchema = z.object({}).strict();

/**
 * 单个 session 的对外形态(snake_case)。
 * `agent_label` 仅 origin === 'agent' 时可能存在,user session 不带此字段。
 * `exit_code` 必须显式 null 或 number(undefined 不行)。
 */
const sessionItemSchema = z
  .object({
    session_id: z.string().min(1),
    title: z.string(),
    cwd: z.string(),
    origin: z.enum(['user', 'agent']),
    agent_label: z.string().optional(),
    created_at: z.number(),
    exit_code: z.number().nullable(),
  })
  .strict();

export const listSessionsOutputSchema = z
  .object({
    sessions: z.array(sessionItemSchema),
  })
  .strict();

export type ListSessionsInput = z.infer<typeof listSessionsInputSchema>;
export type ListSessionsOutput = z.infer<typeof listSessionsOutputSchema>;
export type ListSessionItem = z.infer<typeof sessionItemSchema>;
