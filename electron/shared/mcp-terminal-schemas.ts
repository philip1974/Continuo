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
export const MCP_TOOL_SEND_TEXT = 'terminal.send_text';
export const MCP_TOOL_PRESS_KEY = 'terminal.press_key';
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

/**
 * topic-05 加可选 target hint:agent 指定新 session attach 到哪个 InternalTerminalPanel。
 * kind='active'(默认)— main 通过 IPC query renderer 当前 active terminal panel。
 * kind='panel' — 显式指定 panelId。
 * kind='window' — 指定 windowId,落到该窗口 first visible terminal panel。
 *
 * 现有调用方不传 target 时,行为等价于 { kind: 'active' }(向后兼容)。
 */
export const attachTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('active') }).strict(),
  z.object({ kind: z.literal('panel'), panelId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('window'), windowId: z.number().int() }).strict(),
]);

export type AttachTarget = z.infer<typeof attachTargetSchema>;

export const createSessionInputSchema = z
  .object({
    cwd: z.string().optional(),
    name: z.string().optional(),
    agentLabel: z.string().optional(),
    /** spawn 后 delay 200ms(Windows 600)键入此命令 + \n. */
    autorun: z.string().optional(),
    /** topic-05: optional attach hint. */
    target: attachTargetSchema.optional(),
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

// ── send_text(P4+,c 方案高层 API:纯文本,不附加按键)──────────

export const sendTextInputSchema = z
  .object({
    session_id: z.string().min(1),
    text: z.string().max(SEND_INPUT_MAX_CHARS),
  })
  .strict();

export const sendTextOutputSchema = z.object({}).strict();

export type SendTextInput = z.infer<typeof sendTextInputSchema>;
export type SendTextOutput = z.infer<typeof sendTextOutputSchema>;

// ── press_key(P4+,c 方案高层 API:按键 enum → 字节映射)────────

/** 按键名 → PTY 字节序列。server 内部映射,LLM 只见 key 名. */
export const KEY_BYTES = {
  enter: '\r', // CR(0x0d),raw mode TUI 期望此字符
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f', // DEL,大多 TUI(readline / fish)期望此;BS 0x08 仅老系统
  ctrl_c: '\x03',
  ctrl_d: '\x04',
  ctrl_z: '\x1a',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const;

export type PressKeyName = keyof typeof KEY_BYTES;

const PRESS_KEY_NAMES = Object.keys(KEY_BYTES) as [PressKeyName, ...PressKeyName[]];

export const pressKeyInputSchema = z
  .object({
    session_id: z.string().min(1),
    key: z.enum(PRESS_KEY_NAMES),
  })
  .strict();

export const pressKeyOutputSchema = z.object({}).strict();

export type PressKeyInput = z.infer<typeof pressKeyInputSchema>;
export type PressKeyOutput = z.infer<typeof pressKeyOutputSchema>;

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
