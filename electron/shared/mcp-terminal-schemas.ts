// Agent Terminal MCP — tool schemas。
// schemas 跨 main(校验输入)与 spec(契约断言)共享。
//
// BDD:
//   src/__tests__/agent-terminal-mcp-list-sessions/
//   src/__tests__/agent-terminal-mcp-create-session/

import { z } from 'zod';

// ── tool 名常量 ────────────────────────────────────────────────

export const MCP_TOOL_LIST_SESSIONS = 'terminal.list_sessions';
export const MCP_TOOL_CREATE_SESSION = 'terminal.create_session';
export const MCP_TOOL_SEND_INPUT = 'terminal.send_input';
export const MCP_TOOL_READ_OUTPUT = 'terminal.read_output';
export const MCP_TOOL_KILL = 'terminal.kill';

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

// ── create_session(P2,不含 autorun)──────────────────────────

export const createSessionInputSchema = z
  .object({
    cwd: z.string().optional(),
    name: z.string().optional(),
    agentLabel: z.string().optional(),
    /** spawn 后 delay 200ms(Windows 600)键入此命令 + \n. */
    autorun: z.string().optional(),
  })
  .strict();

export const createSessionOutputSchema = z
  .object({
    session_id: z.string().min(1),
  })
  .strict();

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
export type CreateSessionOutput = z.infer<typeof createSessionOutputSchema>;

// ── send_input(P3)─────────────────────────────────────────────

const SEND_INPUT_MAX_CHARS = 2_000_000;

export const sendInputInputSchema = z
  .object({
    session_id: z.string().min(1),
    data: z.string().max(SEND_INPUT_MAX_CHARS),
  })
  .strict();

export const sendInputOutputSchema = z.object({}).strict();

export type SendInputInput = z.infer<typeof sendInputInputSchema>;
export type SendInputOutput = z.infer<typeof sendInputOutputSchema>;

// ── read_output(P3)────────────────────────────────────────────

const READ_OUTPUT_MAX_LINES = 2000;

export const readOutputInputSchema = z
  .object({
    session_id: z.string().min(1),
    since_seq: z.number().int().nonnegative().optional(),
    max_lines: z.number().int().min(1).max(READ_OUTPUT_MAX_LINES).optional(),
    strip_ansi: z.boolean().optional(),
  })
  .strict();

export const readOutputOutputSchema = z
  .object({
    lines: z.array(z.string()),
    next_seq: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type ReadOutputInput = z.infer<typeof readOutputInputSchema>;
export type ReadOutputOutput = z.infer<typeof readOutputOutputSchema>;

// ── kill(P4)───────────────────────────────────────────────────

export const killInputSchema = z
  .object({
    session_id: z.string().min(1),
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']).optional(),
  })
  .strict();

export const killOutputSchema = z.object({}).strict();

export type KillInput = z.infer<typeof killInputSchema>;
export type KillOutput = z.infer<typeof killOutputSchema>;
