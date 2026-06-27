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
import { truncateSessionIdForEcho } from '../lib/session-id-echo';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import type { OriginHint } from '../../shared/origin-hint';
import { PATH_MAX, LABEL_MAX } from '../../shared/terminal-create';
import { AttachTargetSchema } from '../../shared/terminal-attach';
import type { McpCallCtx, McpToolDef } from './mcp-host.service';
import { z } from 'zod';
import { SESSION_ID_MAX } from '../../shared/session-id-limits';

// 边界(E202,无消费的解析放大面):Continuo 的 create_session 工具只消费
// cwd/name/agentLabel/autorun/target/install_stop_hook/include_raw(见下方 ptyInput 构造),
// **不消费** shell/args/cols/rows/env —— 那些是 server-node(协议包另一消费者)才用的 PTY spawn 字段。
// 协议 createSessionInputSchema(node_modules,与 server-node 共享契约,不可改)含 args: z.array /
// env: z.record **无数量/长度上限**:外部 MCP client 可在 1MB body 塞海量 args/env,让 zod 在工具
// 执行前(mcp-host safeParse)全量深校验这些数组/record,而本工具随即丢弃 = 纯放大面。
// 故 Continuo 侧 omit 未消费字段:strict 下它们成 unrecognized key 被**浅拒**(不深校验内容),
// inputSchema 与本工具 advertised jsonSchema(additionalProperties:false,仅列消费字段)对齐。
// 边界(E32):autorun 64KB backstop(远超任何真实命令)。run() 用 utf8BytesExceed 精确按字节兜底,
// 此处 zod .max 是 code-unit 粗上限(advertised/parse 早拒超长),两者上限同值 MCP_AUTORUN_MAX 防漂移。
const MCP_AUTORUN_MAX = 65536;
// 边界(E205,E203/E204 同族,create_session 三层对齐):此前 createSessionBoundedSchema 只 omit 未消费
// 字段,cwd/name/agentLabel/autorun 的长度上限只在 run()(E32 手动 .length/byte 检查)兜底,zod schema 与
// advertised jsonSchema 都没声明 → MCP client/LLM 看到的入约允许超长字符串,调用时才在 run() 失败(公开
// schema↔zod↔运行时三层漂移)。.extend 给这些字段补 .max(与 run() 上限同值;autorun 的精确 byte 检查仍
// 由 run() 兜底),advertised jsonSchema 同步补 maxLength(见下方 jsonSchema)。保留 .optional()。
const createSessionBoundedSchema = createSessionInputSchema
  .omit({
    shell: true,
    args: true,
    cols: true,
    rows: true,
    env: true,
  })
  .extend({
    cwd: z.string().max(PATH_MAX).optional(),
    name: z.string().max(LABEL_MAX).optional(),
    agentLabel: z.string().max(LABEL_MAX).optional(),
    autorun: z.string().max(MCP_AUTORUN_MAX).optional(),
  });
type CreateSessionBoundedInput = z.infer<typeof createSessionBoundedSchema>;

// 边界(E203):协议各 tool schema 的 session_id 仅 z.string().min(1) **无长度上限**(JSON schema 也只
// minLength:1)。外部 MCP client 可传 1MB session_id,校验通过后进 deps.has/getSessionOwner/write/read/kill
// 的 Map/lookup,虽错误回显已截断(E148/E151),运行期仍反复处理超长 key。Continuo 侧 .extend 把 session_id
// 收窄到 .max(SESSION_ID_MAX)(同 string 类型,z.infer 不变 → 无需改工厂类型)。不改协议包(server-node 共用)。
const sessionIdBounded = z.string().min(1).max(SESSION_ID_MAX);
// 边界(E220,E219 兄弟,字节 vs code-unit 族):send_input/send_text 的 data/text 协议用
// z.string().max(SEND_INPUT_MAX_CHARS) 是 UTF-16 code unit;下游写 PTY 按真实字节。CJK/emoji 多字节
// 输入 length≤上限时真实字节数倍超 → 与 terminal:write(E219)字节语义统一。Continuo 侧 extend 改字节 refine。
const SEND_DATA_MAX_BYTES = 2_000_000;
const sendDataBounded = z
  .string()
  .refine((s) => !utf8BytesExceed(s, SEND_DATA_MAX_BYTES), {
    message: `超过上限 ${SEND_DATA_MAX_BYTES} 字节`,
  });
const sendInputBoundedSchema = sendInputInputSchema.extend({
  session_id: sessionIdBounded,
  data: sendDataBounded,
});
const sendTextBoundedSchema = sendTextInputSchema.extend({
  session_id: sessionIdBounded,
  text: sendDataBounded,
});
const pressKeyBoundedSchema = pressKeyInputSchema.extend({
  session_id: sessionIdBounded,
});
const readOutputBoundedSchema = readOutputInputSchema.extend({
  session_id: sessionIdBounded,
});
const killBoundedSchema = killInputSchema.extend({
  session_id: sessionIdBounded,
});

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
    run: (_input: ListSessionsInput, ctx: McpCallCtx) => {
      const rawSessions = deps.getSessions(ctx);
      const sessions = new Array<ListSessionItem>(rawSessions.length);
      for (let i = 0; i < rawSessions.length; i++) {
        sessions[i] = toItem(rawSessions[i]!);
      }
      return { sessions };
    },
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
  readonly installStopHook?: (
    cwd: string | undefined,
    agentLabel: string,
  ) => Promise<{ installed: boolean; reason?: string }>;
}

export function makeCreateSessionTool(
  deps: CreateSessionToolDeps,
): McpTool<CreateSessionBoundedInput, CreateSessionOutput> {
  return {
    name: MCP_TOOL_CREATE_SESSION,
    description:
      "Create a new visible terminal tab in Continuo and spawn the user's default shell. Optionally autorun a command after spawn (200ms delay; 600ms on Windows). First call triggers a user authorization prompt. " +
      'Session scope: current window only — sessions from other windows return TERMINAL_SESSION_NOT_FOUND.',
    jsonSchema: {
      type: 'object',
      properties: {
        // 边界(E205):advertised maxLength 同步 zod .max / run() 上限(三层一致,防漂移)。
        cwd: {
          type: 'string',
          maxLength: PATH_MAX,
          description: 'Working directory for the spawned shell (default: user home).',
        },
        name: {
          type: 'string',
          maxLength: LABEL_MAX,
          description: 'Tab title (default: "Terminal N").',
        },
        agentLabel: {
          type: 'string',
          maxLength: LABEL_MAX,
          description: 'Short label for the agent (e.g. "codex"). Shown on the tab.',
        },
        autorun: {
          type: 'string',
          maxLength: MCP_AUTORUN_MAX,
          description: 'Command auto-typed into the shell after spawn (with trailing newline).',
        },
        install_stop_hook: {
          type: 'boolean',
          description:
            'When true, install Continuo-managed Stop hook into the CLI settings before spawning. Returns stop_hook_installed in output.',
        },
        include_raw: {
          type: 'boolean',
          description:
            'When true, include the full raw Stop hook payload in await_stop_hook output.',
        },
      },
      additionalProperties: false,
    },
    inputSchema: createSessionBoundedSchema,
    run: async (input: CreateSessionBoundedInput, ctx: McpCallCtx) => {
      // 边界(E32):入参尺寸 fail-closed,先于授权弹窗(畸形请求不该弹窗烦用户),也先于
      // 任何副作用。cwd/name/agentLabel 复用 E11 上限;autorun 用 64KB backstop;target 走
      // AttachTargetSchema(E23,panelId≤256 / windowId 安全整数)。超限 → BAD_INPUT。
      if (
        (input.cwd !== undefined && input.cwd.length > PATH_MAX) ||
        (input.name !== undefined && input.name.length > LABEL_MAX) ||
        (input.agentLabel !== undefined && input.agentLabel.length > LABEL_MAX) ||
        // 边界(E133,E125 同族):autorun 是 64KB **字节** backstop,按真实 UTF-8 字节(非
        // .length=UTF-16 code unit),否则 CJK/emoji autorun 真实字节可数倍超 64KB 仍注入 PTY。
        (input.autorun !== undefined &&
          utf8BytesExceed(input.autorun, MCP_AUTORUN_MAX))
      ) {
        throw Object.assign(
          new Error('create_session input field exceeds size limit'),
          { code: ERROR_CODES.BAD_INPUT },
        );
      }
      if (
        input.target !== undefined &&
        !AttachTargetSchema.safeParse(input.target).success
      ) {
        throw Object.assign(new Error('invalid create_session target'), {
          code: ERROR_CODES.BAD_INPUT,
        });
      }

      const decision = await deps.ensureAuthorized(ctx.ownerWindowId);
      if (decision === 'denied') {
        throw Object.assign(
          new Error('agent terminal not authorized by user'),
          { code: ERROR_CODES.AGENT_NOT_AUTHORIZED },
        );
      }
      // race(R111):用户在授权弹窗上停留期间调用方(stdio proxy)可能已断开 → ctx.signal abort。
      // 此时即便用户点了授权,也不创建会话:否则留下无调用方的孤儿 agent terminal(响应写回死
      // socket、autorun 副作用照跑)。在 installStopHook / createSession 等真正副作用前复查。
      if (ctx.signal?.aborted) {
        throw Object.assign(
          new Error('caller disconnected before session creation'),
          { code: ERROR_CODES.AGENT_NOT_AUTHORIZED },
        );
      }
      let stopHookInstalled: { installed: boolean } | undefined;
      if (input.install_stop_hook === true && deps.installStopHook) {
        try {
          stopHookInstalled = await deps.installStopHook(
            input.cwd,
            input.agentLabel ?? 'agent',
          );
        } catch {
          stopHookInstalled = { installed: false };
        }
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
      return {
        session_id: r.id,
        ...(input.install_stop_hook === true
          ? { stop_hook_installed: stopHookInstalled?.installed ?? false }
          : {}),
      };
    },
  };
}

// ── send_input(P3)─────────────────────────────────────────────

export interface SendInputToolDeps {
  readonly has: (sessionId: string) => boolean;
  // race(R4):write 现 async(await 真实写入结果);保留 boolean 兼容同步 mock。
  readonly write: (sessionId: string, data: string) => boolean | Promise<boolean>;
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

// 边界(E148,E151 同族):session_id 回显截断逻辑已收口到共享 helper(session-id-echo.ts),
// 供本文件与 mcp-tools-hook-bridge.ts 单一来源复用。
const ERR_TERMINAL_SESSION_NOT_FOUND = (id: string) =>
  Object.assign(
    new Error(`terminal session not found: ${truncateSessionIdForEcho(id)}`),
    { code: ERROR_CODES.TERMINAL_SESSION_NOT_FOUND },
  );

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
          // 边界(E204,E203 advertised 对偶):公开 jsonSchema 同步 inputSchema 的 .max(SESSION_ID_MAX),
          // 否则 MCP client/LLM 看到的入约允许超长 session_id、调用时却被运行时 schema 拒 = advertised↔运行时不一致。
          maxLength: SESSION_ID_MAX,
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
    inputSchema: sendInputBoundedSchema,
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
      const ok = await deps.write(input.session_id, preparePtyData(input.data));
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
          // 边界(E204,E203 advertised 对偶):公开 jsonSchema 同步 inputSchema 的 .max(SESSION_ID_MAX),
          // 否则 MCP client/LLM 看到的入约允许超长 session_id、调用时却被运行时 schema 拒 = advertised↔运行时不一致。
          maxLength: SESSION_ID_MAX,
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
    inputSchema: sendTextBoundedSchema,
    run: async (input: SendTextInput, ctx: McpCallCtx) => {
      if (!deps.has(input.session_id)) {
        throw ERR_TERMINAL_SESSION_NOT_FOUND(input.session_id);
      }
      assertSessionInCurrentWindow(
        input.session_id,
        ctx.ownerWindowId,
        deps.getSessionOwner,
      );
      const ok = await deps.write(input.session_id, input.text);
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
          // 边界(E204,E203 advertised 对偶):公开 jsonSchema 同步 inputSchema 的 .max(SESSION_ID_MAX),
          // 否则 MCP client/LLM 看到的入约允许超长 session_id、调用时却被运行时 schema 拒 = advertised↔运行时不一致。
          maxLength: SESSION_ID_MAX,
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
    inputSchema: pressKeyBoundedSchema,
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
      const ok = await deps.write(input.session_id, bytes);
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
  ) => Promise<{ data: string; lines: string[]; nextSeq: number; truncated: boolean }>;
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
          // 边界(E204,E203 advertised 对偶):公开 jsonSchema 同步 inputSchema 的 .max(SESSION_ID_MAX),
          // 否则 MCP client/LLM 看到的入约允许超长 session_id、调用时却被运行时 schema 拒 = advertised↔运行时不一致。
          maxLength: SESSION_ID_MAX,
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
    inputSchema: readOutputBoundedSchema,
    run: async (input: ReadOutputInput, ctx: McpCallCtx) => {
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
        data: r.data,
        lines: r.lines,
        next_seq: r.nextSeq,
        truncated: r.truncated,
      };
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
          // 边界(E204,E203 advertised 对偶):公开 jsonSchema 同步 inputSchema 的 .max(SESSION_ID_MAX),
          // 否则 MCP client/LLM 看到的入约允许超长 session_id、调用时却被运行时 schema 拒 = advertised↔运行时不一致。
          maxLength: SESSION_ID_MAX,
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
    inputSchema: killBoundedSchema,
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
