// Agent Terminal MCP — tool 实装(Phase 1 仅 list_sessions)。
// 工厂注入 deps 便于单测,真路由分发器在后续 phase 接。
//
// BDD: src/__tests__/agent-terminal-mcp-list-sessions/

import {
  MCP_TOOL_LIST_SESSIONS,
  MCP_TOOL_CREATE_SESSION,
  MCP_TOOL_SEND_INPUT,
  MCP_TOOL_SEND_TEXT,
  MCP_TOOL_PRESS_KEY,
  MCP_TOOL_READ_OUTPUT,
  MCP_TOOL_KILL,
  listSessionsInputSchema,
  createSessionInputSchema,
  sendInputInputSchema,
  sendTextInputSchema,
  pressKeyInputSchema,
  readOutputInputSchema,
  killInputSchema,
  KEY_BYTES,
  type ListSessionsInput,
  type ListSessionsOutput,
  type ListSessionItem,
  type CreateSessionInput,
  type CreateSessionOutput,
  type SendInputInput,
  type SendInputOutput,
  type SendTextInput,
  type SendTextOutput,
  type PressKeyInput,
  type PressKeyOutput,
  type ReadOutputInput,
  type ReadOutputOutput,
  type KillInput,
  type KillOutput,
} from '../../shared/mcp-terminal-schemas';
import { ERROR_CODES } from '../../shared/error-codes';
import type { OriginHint } from '../../shared/origin-hint';
import type { McpCallCtx, McpToolDef } from './mcp-host.service';

// ── 输入侧的 store 形态(handler 期望的字段) ────────────────────

/**
 * Phase 1 的 store session 形态。`terminal.store.ts` 后续扩展时按此对齐。
 * 本接口在 schemas / store / handler 三处复用,handler 只读不改。
 */
export interface TerminalSessionLike {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: OriginHint;
  readonly agentLabel?: string;
  readonly createdAt: number;
  readonly exitCode: number | null;
}

export interface ListSessionsToolDeps {
  readonly getSessions: (ctx: McpCallCtx) => readonly TerminalSessionLike[];
}

/**
 * tool 形态;与 mcp-host 注册接口同构。本地 alias 是为了让 P1 单测的
 * `tool.name` / `tool.run` 不直接依赖 mcp-host 的 generic 默认值。
 */
export type McpTool<I, O> = McpToolDef<I, O>;

// ── 字段映射:camelCase store → snake_case 对外 ────────────────

function toItem(s: TerminalSessionLike): ListSessionItem {
  // 用条件赋值代替 `agent_label: s.agentLabel`,确保 user session 输出不含
  // `agent_label` 键(spec 要求字段不出现,而非 undefined)。
  const item: ListSessionItem = {
    session_id: s.id,
    title: s.title,
    cwd: s.cwd,
    origin: s.originHint,
    created_at: s.createdAt,
    exit_code: s.exitCode,
  };
  if (s.agentLabel !== undefined) {
    (item as { agent_label?: string }).agent_label = s.agentLabel;
  }
  return item;
}

// ── 工厂 ───────────────────────────────────────────────────────

export function makeListSessionsTool(
  deps: ListSessionsToolDeps,
): McpTool<ListSessionsInput, ListSessionsOutput> {
  return {
    name: MCP_TOOL_LIST_SESSIONS,
    description:
      'List all current terminal sessions in Continuo (both user-opened and agent-created). ' +
      'Session scope: current window only — sessions in other windows are hidden (filtered out, not enumerable). ' +
      'Per-session tools (read_output / write / kill / send_input / send_text / press_key) return TERMINAL_SESSION_NOT_FOUND when an id from another window is used.',
    jsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    inputSchema: listSessionsInputSchema,
    run: (_input: ListSessionsInput, ctx: McpCallCtx) => ({
      sessions: deps.getSessions(ctx).map(toItem),
    }),
  };
}

// ── create_session(P2)─────────────────────────────────────────

export interface CreateSessionPtyInput {
  readonly cwd?: string;
  readonly name?: string;
  readonly originHint: 'agent';
  readonly agentLabel: string;
  /** spawn 后 delay 200ms(Windows 600)键入此命令 + \n. */
  readonly autorun?: string;
  /** topic-05: optional attach target;透传给 sessionsService 让 renderer 决定 attach 落点。 */
  readonly attachTarget?:
    | { kind: 'active' }
    | { kind: 'panel'; panelId: string }
    | { kind: 'window'; windowId: number };
}

export interface CreateSessionToolDeps {
  /**
   * 调 renderer 端 agent-auth.store.ensure();首次会弹窗。
   * 返回值:
   *  - 'once' / 'session' → 通过
   *  - 'denied' → 拒绝
   */
  readonly ensureAuthorized: (
    ownerWindowId: number,
  ) => Promise<'once' | 'session' | 'denied'>;
  /**
   * 实际 spawn PTY + 入 sessions service。由 main 启动入口注入,把
   * `electron/main/ipc/terminal.ipc.ts` 的 createHandler 包一层(以脱离 BrowserWindow 上下文)。
   */
  readonly createSession: (
    input: CreateSessionPtyInput,
    ctx: McpCallCtx,
  ) => Promise<{ id: string }>;
}

export function makeCreateSessionTool(
  deps: CreateSessionToolDeps,
): McpTool<CreateSessionInput, CreateSessionOutput> {
  return {
    name: MCP_TOOL_CREATE_SESSION,
    description:
      "Create a new visible terminal tab in Continuo and spawn the user's default shell. Optionally autorun a command after spawn (200ms delay; 600ms on Windows). First call triggers a user authorization prompt. " +
      'Session scope: current window only — sessions from other windows return TERMINAL_SESSION_NOT_FOUND.',
    jsonSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Working directory for the spawned shell (default: user home).',
        },
        name: {
          type: 'string',
          description: 'Tab title (default: "Terminal N").',
        },
        agentLabel: {
          type: 'string',
          description: 'Short label for the agent (e.g. "codex"). Shown on the tab.',
        },
        autorun: {
          type: 'string',
          description: 'Command auto-typed into the shell after spawn (with trailing newline).',
        },
      },
      additionalProperties: false,
    },
    inputSchema: createSessionInputSchema,
    run: async (input: CreateSessionInput, ctx: McpCallCtx) => {
      const decision = await deps.ensureAuthorized(ctx.ownerWindowId);
      if (decision === 'denied') {
        throw Object.assign(
          new Error('agent terminal not authorized by user'),
          { code: ERROR_CODES.AGENT_NOT_AUTHORIZED },
        );
      }
      const ptyInput: CreateSessionPtyInput = {
        originHint: 'agent',
        agentLabel: input.agentLabel ?? 'agent',
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.autorun !== undefined ? { autorun: input.autorun } : {}),
        // topic-05: target hint 默认 'active'(无 hint 即 active panel)
        attachTarget: input.target ?? { kind: 'active' },
      };
      const r = await deps.createSession(ptyInput, ctx);
      return { session_id: r.id };
    },
  };
}

// ── send_input(P3)─────────────────────────────────────────────

export interface SendInputToolDeps {
  readonly has: (sessionId: string) => boolean;
  readonly write: (sessionId: string, data: string) => boolean;
  readonly getSessionOwner: (sessionId: string) => number | null;
}

/**
 * send_input 数据预处理(参考 MindAutonAgent3 preparePtyData):
 *   1. unescape LLM 误传的字面 escape(双字符 "\\n" / "\\r" / "\\t" / "\\x03" 等)
 *   2. PTY raw mode TUI 期望 \r 当 Enter,所以 \n → \r;
 *      cooked mode 下 termios ICRNL 会把 \r 转回 \n 给应用,等价行为。
 *
 * send_text / press_key 内部不调此函数(它们语义保证 verbatim / 显式按键映射)。
 */
export function preparePtyData(raw: string): string {
  const unescaped = raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  return unescaped.replace(/\n/g, '\r');
}

const ERR_TERMINAL_SESSION_NOT_FOUND = (id: string) =>
  Object.assign(new Error(`terminal session not found: ${id}`), {
    code: ERROR_CODES.TERMINAL_SESSION_NOT_FOUND,
  });

function assertSessionInCurrentWindow(
  sessionId: string,
  ownerWindowId: number,
  getSessionOwner: (sessionId: string) => number | null,
): void {
  const owner = getSessionOwner(sessionId);
  if (owner !== ownerWindowId) {
    throw ERR_TERMINAL_SESSION_NOT_FOUND(sessionId);
  }
}

export function makeSendInputTool(
  deps: SendInputToolDeps,
): McpTool<SendInputInput, SendInputOutput> {
  return {
    name: MCP_TOOL_SEND_INPUT,
    description:
      "[ADVANCED] Send raw input bytes to a terminal session's PTY stdin. " +
      'PREFER send_text + press_key for normal input — they remove the LF/CR confusion in raw-mode TUIs. ' +
      'Use send_input only for complex byte sequences (mouse events, custom escape codes, binary data). ' +
      'Note: to submit input via this tool, append "\\r" (CR, 0x0d), NOT "\\n" (LF). ' +
      'Raw-mode TUIs (codex, vim, claude, less, ssh) only treat "\\r" as Enter. ' +
      'Returns immediately after writing; use read_output to observe results. ' +
      'Session scope: current window only — sessions from other windows return TERMINAL_SESSION_NOT_FOUND.',
    jsonSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          minLength: 1,
          description: 'Target terminal session id from create_session / list_sessions.',
        },
        data: {
          type: 'string',
          maxLength: 2_000_000,
          description:
            'Raw bytes to write. To press Enter use "\\r" (CR), not "\\n". Example: "ls -la\\r" runs the ls command. Example: "你好\\r" submits text in a TUI prompt.',
        },
      },
      required: ['session_id', 'data'],
      additionalProperties: false,
    },
    inputSchema: sendInputInputSchema,
    run: async (input: SendInputInput, ctx: McpCallCtx) => {
      if (!deps.has(input.session_id)) {
        throw ERR_TERMINAL_SESSION_NOT_FOUND(input.session_id);
      }
      assertSessionInCurrentWindow(
        input.session_id,
        ctx.ownerWindowId,
        deps.getSessionOwner,
      );
      // preparePtyData:LF→CR + 字面 escape unescape,容错 LLM 误传 \n
      const ok = deps.write(input.session_id, preparePtyData(input.data));
      if (!ok) throw ERR_TERMINAL_SESSION_NOT_FOUND(input.session_id);
      return {};
    },
  };
}

// ── send_text(P4+,c 方案:写纯文本,不附加按键)─────────────────

export type SendTextToolDeps = SendInputToolDeps;

export function makeSendTextTool(
  deps: SendTextToolDeps,
): McpTool<SendTextInput, SendTextOutput> {
  return {
    name: MCP_TOOL_SEND_TEXT,
    description:
      'Write plain text to a terminal session. Does NOT append Enter or any control character — pair with press_key("enter") to submit. ' +
      'Prefer this over send_input for normal text input; it removes the LF/CR confusion in raw-mode TUIs (codex, vim, claude). ' +
      'Session scope: current window only — sessions from other windows return TERMINAL_SESSION_NOT_FOUND.',
    jsonSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          minLength: 1,
          description: 'Target terminal session id.',
        },
        text: {
          type: 'string',
          maxLength: 2_000_000,
          description:
            'Plain text written verbatim to PTY stdin. To press Enter afterwards, call press_key with key="enter".',
        },
      },
      required: ['session_id', 'text'],
      additionalProperties: false,
    },
    inputSchema: sendTextInputSchema,
    run: async (input: SendTextInput, ctx: McpCallCtx) => {
      if (!deps.has(input.session_id)) {
        throw ERR_TERMINAL_SESSION_NOT_FOUND(input.session_id);
      }
      assertSessionInCurrentWindow(
        input.session_id,
        ctx.ownerWindowId,
        deps.getSessionOwner,
      );
      const ok = deps.write(input.session_id, input.text);
      if (!ok) throw ERR_TERMINAL_SESSION_NOT_FOUND(input.session_id);
      return {};
    },
  };
}

// ── press_key(P4+,c 方案:按键 enum → 字节)─────────────────────

export type PressKeyToolDeps = SendInputToolDeps;

export function makePressKeyTool(
  deps: PressKeyToolDeps,
): McpTool<PressKeyInput, PressKeyOutput> {
  return {
    name: MCP_TOOL_PRESS_KEY,
    description:
      'Press a single special key in the terminal session. The server maps the key name to the correct PTY byte sequence ' +
      '(enter=CR, tab, escape, backspace=DEL, ctrl_c, ctrl_d, ctrl_z, arrow keys). ' +
      'Pair with send_text for typing followed by submit. Prefer this over send_input for special keys — it removes ' +
      'guesswork about LF vs CR and TUI key encodings. ' +
      'Session scope: current window only — sessions from other windows return TERMINAL_SESSION_NOT_FOUND.',
    jsonSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          minLength: 1,
          description: 'Target terminal session id.',
        },
        key: {
          type: 'string',
          enum: Object.keys(KEY_BYTES),
          description:
            'Key to press. enter=submit (raw-mode TUIs); ctrl_c=interrupt; ctrl_d=EOF; arrows=cursor; backspace=DEL.',
        },
      },
      required: ['session_id', 'key'],
      additionalProperties: false,
    },
    inputSchema: pressKeyInputSchema,
    run: async (input: PressKeyInput, ctx: McpCallCtx) => {
      if (!deps.has(input.session_id)) {
        throw ERR_TERMINAL_SESSION_NOT_FOUND(input.session_id);
      }
      assertSessionInCurrentWindow(
        input.session_id,
        ctx.ownerWindowId,
        deps.getSessionOwner,
      );
      const bytes = KEY_BYTES[input.key];
      const ok = deps.write(input.session_id, bytes);
      if (!ok) throw ERR_TERMINAL_SESSION_NOT_FOUND(input.session_id);
      return {};
    },
  };
}

// ── read_output(P3)────────────────────────────────────────────

export interface ReadOutputToolDeps {
  readonly read: (
    sessionId: string,
    opts: {
      sinceSeq?: number;
      maxLines?: number;
      stripAnsi?: boolean;
    },
  ) => Promise<{ lines: string[]; nextSeq: number; truncated: boolean }>;
  readonly getSessionOwner: (sessionId: string) => number | null;
}

export function makeReadOutputTool(
  deps: ReadOutputToolDeps,
): McpTool<ReadOutputInput, ReadOutputOutput> {
  return {
    name: MCP_TOOL_READ_OUTPUT,
    description:
      'Read accumulated output from a terminal session as line-split text. Default: ANSI stripped, last 200 lines. Use since_seq cursor (returned as next_seq) for incremental reads. ' +
      'Session scope: current window only — sessions from other windows return TERMINAL_SESSION_NOT_FOUND.',
    jsonSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          minLength: 1,
          description: 'Target terminal session id.',
        },
        since_seq: {
          type: 'integer',
          minimum: 0,
          description:
            'Incremental cursor: pass the next_seq from a previous read. Default 0 (returns from earliest entry retained).',
        },
        max_lines: {
          type: 'integer',
          minimum: 1,
          maximum: 2000,
          description:
            'Max lines returned. If exceeded, truncated=true and only last N lines returned. Default 200.',
        },
        strip_ansi: {
          type: 'boolean',
          description: 'Strip ANSI escape sequences (CSI/OSC/keypad). Default true.',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    inputSchema: readOutputInputSchema,
    run: async (input: ReadOutputInput, ctx: McpCallCtx) => {
      try {
        assertSessionInCurrentWindow(
          input.session_id,
          ctx.ownerWindowId,
          deps.getSessionOwner,
        );
        const opts: {
          sinceSeq?: number;
          maxLines?: number;
          stripAnsi?: boolean;
        } = {};
        if (input.since_seq !== undefined) opts.sinceSeq = input.since_seq;
        if (input.max_lines !== undefined) opts.maxLines = input.max_lines;
        if (input.strip_ansi !== undefined) opts.stripAnsi = input.strip_ansi;
        const r = await deps.read(input.session_id, opts);
        return {
          lines: r.lines,
          next_seq: r.nextSeq,
          truncated: r.truncated,
        };
      } catch (err) {
        throw err;
      }
    },
  };
}

// ── kill(P4)───────────────────────────────────────────────────

export interface KillToolDeps {
  readonly has: (sessionId: string) => boolean;
  /** SIGINT:写 \x03 给 PTY,不退出. */
  readonly interrupt: (sessionId: string) => void;
  /** SIGTERM:SIGINT + 3s grace + force(termService.kill 现行行为). */
  readonly kill: (sessionId: string) => void;
  /** SIGKILL:直接 pty.kill('SIGKILL'). */
  readonly forceKill: (sessionId: string) => void;
  readonly getSessionOwner: (sessionId: string) => number | null;
}

export function makeKillTool(
  deps: KillToolDeps,
): McpTool<KillInput, KillOutput> {
  return {
    name: MCP_TOOL_KILL,
    description:
      'Send a signal to a terminal session. SIGINT writes Ctrl+C without exiting; SIGTERM (default) sends SIGINT then force-kills after 3s grace; SIGKILL kills immediately. Tab metadata and output buffer are preserved (use list_sessions to see exit_code). ' +
      'Session scope: current window only — sessions from other windows return TERMINAL_SESSION_NOT_FOUND.',
    jsonSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          minLength: 1,
          description: 'Target terminal session id.',
        },
        signal: {
          type: 'string',
          enum: ['SIGINT', 'SIGTERM', 'SIGKILL'],
          description: 'Signal to send. Default SIGTERM.',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    inputSchema: killInputSchema,
    run: async (input: KillInput, ctx: McpCallCtx) => {
      if (!deps.has(input.session_id)) {
        throw ERR_TERMINAL_SESSION_NOT_FOUND(input.session_id);
      }
      assertSessionInCurrentWindow(
        input.session_id,
        ctx.ownerWindowId,
        deps.getSessionOwner,
      );
      const sig = input.signal ?? 'SIGTERM';
      if (sig === 'SIGINT') deps.interrupt(input.session_id);
      else if (sig === 'SIGKILL') deps.forceKill(input.session_id);
      else deps.kill(input.session_id); // SIGTERM
      return {};
    },
  };
}
