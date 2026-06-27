// MCP host(Agent Terminal MCP Phase 1)。
// 暴露 6 个纯函数契约层(单测覆盖)+ createMcpHost HTTP wiring(留 E2E)。
//
// 协议(P1 极简版):
//   POST /message  JSON-RPC 2.0 单请求/响应,直接通过 HTTP body 同步返回。
//   GET  /sse      占位 SSE endpoint,P3+ 才真正用于 server-initiated 通知。
//
// Bearer 鉴权:`Authorization: Bearer <token>`。Token 启动时生成,close 时作废。
// 仅监听 127.0.0.1(isLocalhostBindAddr 校验,防误监听 0.0.0.0)。
//
// BDD: src/__tests__/agent-terminal-mcp-host/(纯函数层)

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import type { z } from 'zod';
import { formatZodErrorCapped } from '../lib/format-zod-error';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  boundedObjectAdmissible,
  MAX_BOUNDED_OBJECT_KEYS,
  MAX_BOUNDED_OBJECT_KEY_LEN,
} from '../../shared/bounded-input';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { jsonByteLowerBoundExceeds } from '../../shared/json-byte-budget';
import { RESULT_BYTES_MAX } from '../../shared/plugin-mcp-schemas';
import { PLUGIN_MCP_ERROR_CODES } from '../../shared/plugin-mcp-channels';

// ── 常量 ────────────────────────────────────────────────────────

/** JSON-RPC 2.0 标准 + 自定义错误码. */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  /** 自定义,落在 JSON-RPC 实现保留区(-32000 ~ -32099). */
  UNAUTHORIZED: -32001,
  NO_WINDOW_CTX: -32002,
  /** 边界(E291):tools/list 聚合响应超字节上限(防 MB 级 JSON.stringify OOM). */
  RESULT_TOO_LARGE: -32003,
} as const;

// 边界(E291,E286 字节预算族 / 聚合维度):tools/list 把全部已注册 tool 的 name/description/jsonSchema
// 聚合进单个响应。每 tool 的 schema(SCHEMA_BYTES_MAX 64KiB)/description(DESC_MAX)各有上限,且 tool 数
// 有上限(plugin-mcp-bridge MAX_TOOLS_GLOBAL=2048),但**乘积**(2048 × ~64KiB ≈ 128MB)无聚合上限 →
// formatRpcResult() 的 JSON.stringify 产生 MB 级字符串经 HTTP/stdio 放大主进程内存。给 tools/list 聚合
// 加字节上限(远高于任何真实 tool 集的 KB 级 tools/list,仅挡恶意插件批量超大 schema);超限返
// RESULT_TOO_LARGE 错误而非物化巨响应。
const MAX_TOOLS_LIST_BYTES = 16 * 1024 * 1024; // tools/list 聚合响应 ≤ 16MiB

export const NO_WINDOW_CTX_MESSAGE = 'missing window context';

// 边界(E78,E73/E75/E76/E77 错误串放大族 + 回显面):JSON-RPC id/method 与 tools/call 的
// params.name 都是短标识符。此前 parseRpcMessage 只校验 method 非空、id 为 string|number,无长度
// 上限;失败路径把原值拼进「method not found / tool not found」并在响应里回显 id。恶意本地 MCP
// client 可在 1MB body 内构造超长 method/name/id,让错误响应/日志放大、占主进程 CPU/内存。
// 给三者加长度上限:method/id 超限 → parseRpcMessage 返 null(走固定 PARSE_ERROR,不回显原串);
// params.name 超限 → 固定 INVALID_PARAMS(不回显)。正常标识符远在上限内。
const MAX_RPC_FIELD_LEN = 1024;

// 边界(E295):HTTP request-target(req.url)长度上限。Node 默认 maxHeaderSize ~16KB 已隐式封顶整个
// header 块,但显式 414(URI Too Long)上限不依赖 Node 配置(若他处调高 maxHeaderSize 仍有界),且
// 配合 indexOf/slice(替代 split('?') 物化所有 ?-分段)更省。任何真实 MCP 请求目标(/mcp[?...])远在内。
export const MAX_REQUEST_TARGET_LEN = 8192;

/**
 * 边界(E295):解析 HTTP request-target —— 超 MAX_REQUEST_TARGET_LEN → tooLong(调用方回 414);
 * 否则去 query(indexOf/slice,不 split('?') 物化所有分段)返 path。纯函数,单测覆盖(HTTP wiring 留 E2E)。
 */
export function parseHttpRequestTarget(rawUrl: string | undefined): {
  readonly tooLong: boolean;
  readonly path: string;
} {
  const rawTarget = rawUrl ?? '/';
  if (rawTarget.length > MAX_REQUEST_TARGET_LEN) {
    return { tooLong: true, path: '/' };
  }
  const qIdx = rawTarget.indexOf('?');
  return {
    tooLong: false,
    path: qIdx === -1 ? rawTarget : rawTarget.slice(0, qIdx),
  };
}

const LOCALHOST_ADDRS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
]);

export interface McpCallCtx {
  readonly ownerWindowId: number;
  /**
   * 安全 S3:MCP 调用方身份(HTTP=bearer token,stdio=每连接 subject)。读/写/杀类
   * 工具据此校验目标会话是否由本调用方创建(session.controllerToken === callerSubject)。
   * undefined/null(内部/单测直接构造 ctx)→ 不持任何 capability,被 capability 校验拒绝。
   */
  readonly callerSubject?: string | null;
  /**
   * race(R111):本次调用的取消信号。stdio 连接断开(socket close)时 abort,供有副作用且在
   * 用户授权 await 上挂起的工具(如 create_session)在真正产生副作用前复查 —— 已取消则拒绝,
   * 不创建无调用方的孤儿会话。可选:HTTP host / 内部构造 ctx 不传 → 工具按未取消处理。
   */
  readonly signal?: AbortSignal;
}

export interface McpRevokers {
  readonly byWindow: (windowId: number) => void;
  readonly byToken: (token: string) => void;
}

let _mcpRevokers: McpRevokers = {
  byWindow: () => {},
  byToken: () => {},
};

export function setMcpRevokers(fns: McpRevokers): void {
  _mcpRevokers = fns;
}

export function mcpRevokers(): McpRevokers {
  return _mcpRevokers;
}

// ── token ───────────────────────────────────────────────────────

/**
 * 生成 URL-safe token(32 字节熵 → 43 字符 base64url),
 * 字符集 [A-Za-z0-9-_],无 `/+=`,可直接放 Authorization header。
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

// ── Bearer 校验 ─────────────────────────────────────────────────

/**
 * 校验 `Authorization: Bearer <token>`,scheme 大小写不敏感,
 * token 与 expected 走常量时间比较;长度不同先短路,避免 timingSafeEqual 抛错。
 *
 * expected 为空 / 假值 → 一律 false(防 token 未初始化绕过)。
 */
export function verifyBearer(
  authHeader: string | undefined,
  expected: string,
): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof authHeader !== 'string' || authHeader.length === 0) return false;
  const m = /^bearer (.+)$/i.exec(authHeader);
  if (!m) return false;
  const token = m[1];
  if (!token || token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── JSON-RPC 编解码 ─────────────────────────────────────────────

export interface RpcRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * 解析未信任的输入为 JSON-RPC 2.0 请求。任何不满足必字段 → null。
 *
 * 本 host 比标准更严:
 * - id 不接受 null(简化重传逻辑)
 * - params 必须是 plain object(数组也拒,一律 named params)
 */
export function parseRpcMessage(raw: unknown): RpcRequest | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj['jsonrpc'] !== '2.0') return null;

  const method = obj['method'];
  if (typeof method !== 'string' || method.length === 0) return null;
  // 边界(E78):method 超长 → null(走固定 PARSE_ERROR,不把超长串回显进 method not found)。
  if (method.length > MAX_RPC_FIELD_LEN) return null;

  const id = obj['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  // 边界(E78):string id 超长 → null(不回显进响应 id 字段)。
  if (typeof id === 'string' && id.length > MAX_RPC_FIELD_LEN) return null;
  // 边界(E95,E91/E92 安全整数族):number id 须安全整数。Infinity/NaN/超 MAX_SAFE_INTEGER 经
  // formatRpcResult/Error 的 JSON.stringify 会序列化成 null 或被舍入 → 外部 MCP client 收到的
  // 响应 id 不再等于请求 id,请求/响应无法关联(stdio 与 HTTP 两入口共用此 parser)。非安全
  // 整数 → null(走固定 parse error)。
  if (typeof id === 'number' && !Number.isSafeInteger(id)) return null;

  let params: Record<string, unknown> = {};
  if ('params' in obj && obj['params'] !== undefined) {
    const p = obj['params'];
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
    params = p as Record<string, unknown>;
  }

  return { id, method, params };
}

/** 编码 JSON-RPC 2.0 result 响应(单行 JSON). */
export function formatRpcResult(
  id: string | number | null,
  result: unknown,
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/**
 * 编码 JSON-RPC 2.0 error 响应(单行 JSON)。
 * data 缺省时不出现在 error 对象里(无 `data: undefined` 字面)。
 */
export function formatRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): string {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

// ── bind 白名单 ─────────────────────────────────────────────────

/**
 * 仅 `127.0.0.1` / `::1` / `localhost` 三者返回 true(大小写敏感)。
 * 启动 HTTP server 前调,非白名单 → 拒绝绑定(防误监听 0.0.0.0 暴露外网)。
 */
export function isLocalhostBindAddr(addr: string): boolean {
  if (typeof addr !== 'string') return false;
  return LOCALHOST_ADDRS.has(addr);
}

/**
 * Host header 必须是本机回环地址 + 当前端口。用于挫败 DNS rebinding
 * (rebinding 后浏览器发来的 Host 是攻击者域名,与回环地址不符)。
 */
export function isLoopbackHostHeader(
  hostHeader: string | undefined,
  port: number,
): boolean {
  if (typeof hostHeader !== 'string' || port <= 0) return false;
  const h = hostHeader.toLowerCase();
  return (
    h === `127.0.0.1:${port}` ||
    h === `localhost:${port}` ||
    h === `[::1]:${port}`
  );
}

// ── MCP 标准协议 dispatcher ──────────────────────────────────────

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
}

export type RpcResponseObj =
  | { readonly result: unknown }
  | {
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    };

/**
 * 路由 MCP 标准 method:initialize / tools/list / tools/call。
 * 旧 P1 的"method 即 tool name"形态在标准 dispatcher 下走 default 拒,
 * 客户端必须用 `tools/call` 包装。
 *
 * BDD: src/__tests__/agent-terminal-mcp-dispatcher/
 */
export async function dispatchRpc(
  rpc: RpcRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ReadonlyMap<string, McpToolDef<any, any>>,
  serverInfo: ServerInfo,
  ctx: McpCallCtx | null,
): Promise<RpcResponseObj> {
  if (rpc.method === 'initialize') {
    return {
      result: {
        protocolVersion: serverInfo.protocolVersion,
        serverInfo: { name: serverInfo.name, version: serverInfo.version },
        capabilities: { tools: {} },
      },
    };
  }

  if (rpc.method === 'tools/list') {
    const toolList: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [];
    for (const t of tools.values()) {
      toolList.push({
        name: t.name,
        description: t.description,
        inputSchema: t.jsonSchema,
      });
    }
    // 边界(E291,字节预算 fail-fast):聚合 tools/list 超 MAX_TOOLS_LIST_BYTES → 在 formatRpcResult
    // 的 JSON.stringify 物化 MB 级字符串之前返错(下界永不高估,判定与精确字节等价,免 OOM)。
    if (jsonByteLowerBoundExceeds(toolList, MAX_TOOLS_LIST_BYTES)) {
      return {
        error: {
          code: RPC_ERROR_CODES.RESULT_TOO_LARGE,
          message: 'tools/list result exceeds size limit',
        },
      };
    }
    return { result: { tools: toolList } };
  }

  if (rpc.method === 'tools/call') {
    if (ctx === null) {
      return {
        error: {
          code: RPC_ERROR_CODES.NO_WINDOW_CTX,
          message: NO_WINDOW_CTX_MESSAGE,
        },
      };
    }
    const params = rpc.params;
    const name = params['name'];
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      // 边界(E78):name 超长 → 固定 INVALID_PARAMS,不把超长串回显进 tool not found。
      name.length > MAX_RPC_FIELD_LEN
    ) {
      return {
        error: {
          code: RPC_ERROR_CODES.INVALID_PARAMS,
          message: 'tools/call: params.name (string) required',
        },
      };
    }
    const tool = tools.get(name);
    if (!tool) {
      return {
        error: {
          code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
          message: `tool not found: ${name}`,
        },
      };
    }
    let args: unknown = params['arguments'];
    if (args === undefined) args = {};
    if (
      args === null ||
      typeof args !== 'object' ||
      Array.isArray(args)
    ) {
      return {
        error: {
          code: RPC_ERROR_CODES.INVALID_PARAMS,
          message: 'tools/call: arguments must be a plain object',
        },
      };
    }
    // 边界(E255):safeParse 前先做 bounded 预检(key 数 / 单 key 长度),挡 1MB body 海量未知短 key
    // 在 Zod .strict() 枚举 + 构造 unrecognized_keys issue 阶段放大 CPU/内存(错误串 cap 在 parse 后才生效)。
    const argsBound = checkToolArgsBounded(args as Record<string, unknown>);
    if (!argsBound.ok) {
      return {
        error: {
          code: RPC_ERROR_CODES.INVALID_PARAMS,
          message: argsBound.message,
        },
      };
    }
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      return {
        error: {
          code: RPC_ERROR_CODES.INVALID_PARAMS,
          // 边界(E73):错误串经 cap(同 safeHandle),防工具入参 schema 大量 issue 放大。
          message: formatZodErrorCapped(parsed.error),
        },
      };
    }
    try {
      const result = await tool.run(parsed.data, ctx);
      // 边界(E288,E286 同族 / host 通用输出边界 fail-fast):字节下界 > RESULT_BYTES_MAX ⇒ 必超限,
      // 在 JSON.stringify 物化巨字符串之前拒。plugin tool 结果已经 isInvokeResultAdmissible(E262/E265)
      // 限过,但内置/未来注册的 tool 结果不走 bridge —— 此处是 host 通用边界,补字节预算 fail-fast。
      // 不前置 assertJsonValue(保持 E120 空结果 + 既有强转行为不变),仅加预检,判定与下方精确字节 cap 等价。
      if (jsonByteLowerBoundExceeds(result, RESULT_BYTES_MAX)) {
        return {
          error: formatToolCallError({
            code: PLUGIN_MCP_ERROR_CODES.RESULT_TOO_LARGE,
            message: 'tool result exceeds size limit',
          }),
        };
      }
      // MCP 协议:tool result 包成 content array(MCP client 期望此形态)
      // 边界(E120,E117 配套):result 可为 undefined(InvokeReplySchema 放行的「空结果」),
      // 或顶层 function/symbol 使 JSON.stringify 返回 undefined → text:undefined 经 JSON-RPC
      // 序列化被省略成 {type:'text'}(text 必填)→ 不合法 MCP content,客户端解析失败/丢结果。
      // 空结果显式回退空字符串。
      const serialized = JSON.stringify(result);
      const text = serialized === undefined ? '' : serialized;
      // 边界(E267,E266 result-path 对偶):host 对 tool.run 成功结果此前无通用字节上限。内置/未来注册的
      // MCP tool 若返回超大对象/字符串 → 序列化成巨大 content[0].text 经 HTTP/SSE/stdio 回传放大主进程内存/
      // 输出。plugin bridge 的 result 上限(E262/E265)只护插件回包入口,不护 host 通用边界。超
      // RESULT_BYTES_MAX(同一来源,10MB)返固定 RESULT_TOO_LARGE 错误,不回传超大 content。
      if (utf8BytesExceed(text, RESULT_BYTES_MAX)) {
        return {
          error: formatToolCallError({
            code: PLUGIN_MCP_ERROR_CODES.RESULT_TOO_LARGE,
            message: 'tool result exceeds size limit',
          }),
        };
      }
      return {
        result: {
          content: [{ type: 'text', text }],
        },
      };
    } catch (err) {
      // 边界(E266):err.message/err.code 经 host 边界截断,防畸形/恶意 tool 抛超长串经 JSON-RPC 放大。
      return { error: formatToolCallError(err) };
    }
  }

  return {
    error: {
      code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
      message: `method not found: ${rpc.method}`,
    },
  };
}

// ── createMcpHost(HTTP wiring,留 E2E)──────────────────────────

export interface McpToolDef<I = unknown, O = unknown> {
  readonly name: string;
  /** 给 LLM 看的工具说明(英文,Claude Code 等通用 MCP client 选用). */
  readonly description: string;
  /** 给 MCP client tools/list 看的 JSON Schema(非 zod). 工厂手填字面量. */
  readonly jsonSchema: Record<string, unknown>;
  /**
   * 本地校验 input 的 zod schema。**output** 类型为 I(run 拿到的 parsed.data 形态);
   * input 类型放 unknown,以接受带 `.default()` / `.transform()` 的 schema(其 z.input
   * 与 z.output 形态不同)。可维护性 M18:此前 await_stop_hook 因 schema 带 .default()
   * 被迫 `awaitStopHookInputSchema as unknown as ...['inputSchema']`,放宽后可直接赋值。
   */
  readonly inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  readonly run: (input: I, ctx: McpCallCtx) => O | Promise<O>;
}

// host 内部统一用 any generic — 它只 dispatch,不关心 tool 的具体 I/O 形态。
// 各 tool 自己用 McpToolDef<I, O> 保留外部强类型。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMcpTool = McpToolDef<any, any>;

export interface McpHost {
  readonly port: number;
  readonly url: string;
  /** 共享给 stdio transport 等其它入口复用. */
  readonly tools: ReadonlyMap<string, AnyMcpTool>;
  /** 共享给 stdio transport 等其它入口复用. */
  readonly serverInfo: ServerInfo;
  issueWindowToken(windowId: number): string;
  revokeToken(token: string): void;
  revokeWindowTokens(windowId: number): void;
  resolveWindowId(token: string): number | null;
  verifyAndResolveCtx(authHeader: string | undefined): McpCallCtx | null;
  registerTool(tool: AnyMcpTool): void;
  /** registerTool 反操作。unknown name 静默 noop. */
  removeTool(name: string): void;
  /**
   * 推 JSON-RPC notification(无 id)给所有 SSE 客户端。
   * 例:`broadcast('notifications/tools/list_changed')` 让 client 重拉 tools/list。
   * 写入失败的 connection 自动从 sseClients 摘掉。
   */
  broadcast(method: string, params?: Record<string, unknown>): void;
  rotateToken(): void;
  close(): Promise<void>;
}

export interface McpHostOptions {
  bindAddr?: string;
  port?: number;
  initialTools?: ReadonlyArray<AnyMcpTool>;
  /** 默认 {name:'continuo', version:'0.1.0', protocolVersion:'2024-11-05'}. */
  serverInfo?: Partial<ServerInfo>;
}

const DEFAULT_SERVER_INFO: ServerInfo = {
  name: 'continuo',
  version: '0.1.0',
  protocolVersion: '2024-11-05',
};

const MAX_BODY_BYTES = 1_000_000; // 1MB,防 body bomb
const SSE_KEEPALIVE_MS = 25_000;   // SSE 心跳,防中间件 idle 断

// 边界(E232,E227-E231 数量上限族):MCP HTTP host SSE 长连接数量上限。每个 GET /mcp 成功后保留一个
// ServerResponse + keepalive setInterval + sseClients Map 条目,只在 close/revoke 才清。持合法 bearer
// token 的本地客户端可反复打开大量 SSE 不关闭 → main 累积 socket/ServerResponse/timer + broadcast() 对
// 全部连接线性写入 → 资源耗尽 + UI/agent 通知卡顿。建连前全局 + per-token 双闸,超限 429 拒(不建连、
// 不起 keepalive、不入 Map)。closeSseClient 统一清理路径不变。
const MAX_SSE_CLIENTS_GLOBAL = 64; // 全局 SSE 连接上限(远超任何正常 client 并发)
const MAX_SSE_CLIENTS_PER_TOKEN = 16; // 单 token SSE 连接上限

// 边界(E266,E73/E157 错误串放大族):tools/call catch 把 tool.run 抛出的 err.message/err.code 原样塞进
// JSON-RPC error 回传给外部 MCP client(HTTP/stdio)。畸形/恶意 tool 抛超长 message/code → 主进程序列化
// 并回传巨型 error → 内存/输出放大或 MCP client 卡死。在 host 边界截断(与 safe-handle ERR_MESSAGE_MAX/
// ERR_CODE_MAX 同量级 8192/256)。导出供单测。
export const MCP_ERR_MESSAGE_MAX = 8192;
export const MCP_ERR_CODE_MAX = 256;
function capMcpErrText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max})` : s;
}

/**
 * 边界(E266):把 tool.run 抛出的 err 规整成 JSON-RPC error(code/message/data.code 均经长度截断,
 * 防超长串经 JSON-RPC 回传放大)。纯函数,供 tools/call catch 与单测共用。
 */
export function formatToolCallError(err: unknown): {
  code: number;
  message: string;
  data?: { code: string };
} {
  // 边界:err 可为 null/原始值(tool throw 任意值)—— null/undefined 上读 .message 会抛,先归一化为对象。
  const e = (
    err !== null && typeof err === 'object' ? err : {}
  ) as { code?: unknown; message?: unknown };
  const out: { code: number; message: string; data?: { code: string } } = {
    code: -32603,
    message: capMcpErrText(
      typeof e.message === 'string' ? e.message : 'internal error',
      MCP_ERR_MESSAGE_MAX,
    ),
  };
  if (typeof e.code === 'string') {
    out.data = { code: capMcpErrText(e.code, MCP_ERR_CODE_MAX) };
  }
  return out;
}

// 边界(E255,读端独立校验 / schema-阶段放大):tools/call 把外部 MCP arguments 直接交给
// tool.inputSchema.safeParse(args)。多数 tool schema 是 .strict() object,畸形本地 MCP client 可在
// 1MB body 内塞海量未知短 key —— Zod 会先**枚举全部 key**并为每个 unrecognized key 构造 issue/message
// 数组,错误串 cap(formatZodErrorCapped)在这之后才生效 → 单请求即可让 main 进程在 schema 阶段
// CPU/内存放大,阻塞 MCP host 与 Electron 主进程。故在 safeParse **之前**加通用 bounded 预检:限制
// arguments 自有 key 数与单 key 长度,超限直接返回固定 INVALID_PARAMS,不进入 Zod。
// 边界(E257 重构):核心逻辑收口到 shared boundedObjectAdmissible(三入口单一来源消漂移),此处只做
// MCP 领域错误文案映射,保持本入口既有契约(常量名 / message)。
export const MAX_TOOL_ARG_KEYS = MAX_BOUNDED_OBJECT_KEYS;
export const MAX_TOOL_ARG_KEY_LEN = MAX_BOUNDED_OBJECT_KEY_LEN;

/**
 * 边界(E255):tools/call arguments 的 bounded 预检(纯函数,便于测试)。在 safeParse 前调用。
 * 委托 shared boundedObjectAdmissible,失败时映射成 tools/call 领域文案。
 */
export function checkToolArgsBounded(
  args: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  const r = boundedObjectAdmissible(args);
  if (r.ok) return { ok: true };
  return {
    ok: false,
    message:
      r.reason === 'too-many-keys'
        ? 'tools/call: too many argument keys'
        : 'tools/call: argument key too long',
  };
}

/**
 * 边界(E232):SSE 接入准入判定(纯函数,便于测试)。当前全局连接数或该 token 的连接数达上限 → 拒。
 * handleSse 建连前调用,false → 返 429 不建连。
 */
export function sseAdmissionAllowed(
  globalCount: number,
  perTokenCount: number,
): boolean {
  return (
    globalCount < MAX_SSE_CLIENTS_GLOBAL &&
    perTokenCount < MAX_SSE_CLIENTS_PER_TOKEN
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: ERROR_CODES.PAYLOAD_TOO_LARGE }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, json: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(json);
}

export async function createMcpHost(
  options: McpHostOptions = {},
): Promise<McpHost> {
  const bindAddr = options.bindAddr ?? '127.0.0.1';
  if (!isLocalhostBindAddr(bindAddr)) {
    throw Object.assign(new Error(`MCP host bind forbidden: ${bindAddr}`), {
      code: ERROR_CODES.MCP_HOST_BIND_FORBIDDEN,
    });
  }

  const tools = new Map<string, AnyMcpTool>();
  for (const t of options.initialTools ?? []) tools.set(t.name, t);

  const serverInfo: ServerInfo = {
    ...DEFAULT_SERVER_INFO,
    ...(options.serverInfo ?? {}),
  };

  const windowTokens: Map<string, number> = new Map();
  // race(R76):SSE client 记 {windowId, token, keepalive},供 revokeToken/revokeWindowTokens
  // 精确关闭对应连接 + 清 keepalive interval(此前只是 Set<res>,定向 revoke 无法触达已建立的
  // SSE → 撤销后 stale 连接仍 keepalive + 继续收 broadcast,资源泄漏)。
  const sseClients = new Map<
    ServerResponse,
    { windowId: number; token: string | null; keepalive: NodeJS.Timeout }
  >();
  // 关闭单个 SSE client:清 keepalive、移出表、end 连接(幂等)。
  const closeSseClient = (res: ServerResponse): void => {
    const meta = sseClients.get(res);
    if (meta) clearInterval(meta.keepalive);
    sseClients.delete(res);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };

  const handleMessage = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const ctx = host.verifyAndResolveCtx(req.headers['authorization']);
    if (!ctx) {
      sendJson(
        res,
        401,
        formatRpcError(null, RPC_ERROR_CODES.UNAUTHORIZED, 'unauthorized'),
      );
      return;
    }

    let raw: unknown;
    try {
      const body = await readBody(req);
      raw = JSON.parse(body);
    } catch {
      sendJson(
        res,
        200,
        formatRpcError(null, RPC_ERROR_CODES.PARSE_ERROR, 'parse error'),
      );
      return;
    }

    // MCP notification:JSON-RPC 没 id,server 不响应(202 Accepted)。
    // 例如 'notifications/initialized' 客户端 init 完后发的通知。
    if (
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>)['jsonrpc'] === '2.0' &&
      typeof (raw as Record<string, unknown>)['method'] === 'string' &&
      !('id' in (raw as Record<string, unknown>))
    ) {
      res.statusCode = 202;
      res.end();
      return;
    }

    const rpc = parseRpcMessage(raw);
    if (!rpc) {
      sendJson(
        res,
        200,
        formatRpcError(null, RPC_ERROR_CODES.PARSE_ERROR, 'invalid JSON-RPC 2.0'),
      );
      return;
    }

    // race(R75):token 仅在上面 readBody 之前校验过一次(得到 ctx)。readBody/JSON.parse 可能
    // 较慢,期间若发生 rotateToken()/revoke(用户撤销 agent 授权 → revokeAndKillAgentSessions
    // → rotateToken),旧 ctx 已失效但仍会被这里的 dispatchRpc 复用 —— 让「撤销后、body 尚未发完」
    // 的旧 token 请求仍能调用工具(绕过撤销)。dispatch 前用最新 token 状态重新 verifyAndResolveCtx,
    // 失败则 401 且不复用旧 ctx;成功则用 freshCtx(窗口归属可能也已变,以最新为准)。
    const freshCtx = host.verifyAndResolveCtx(req.headers['authorization']);
    if (!freshCtx) {
      sendJson(
        res,
        401,
        formatRpcError(rpc.id, RPC_ERROR_CODES.UNAUTHORIZED, 'unauthorized'),
      );
      return;
    }
    // race(R112,R111 同源 HTTP 侧):client 断开后不取消在途 dispatchRpc,有副作用工具
    // (create_session)若卡在 ensureAuthorized 授权 await,断开后用户再授权仍会创建无调用方的
    // 孤儿 agent terminal,最后只把响应写死连接。每请求一个 AbortController,req/res close 时 abort
    // → 注入 ctx.signal,create_session 在授权后、副作用前复查(R111 已实装),已取消则拒绝;响应
    // 也不写回已断连接。
    const aborter = new AbortController();
    const onClose = (): void => aborter.abort();
    req.on('close', onClose);
    res.on('close', onClose);
    try {
      const response = await dispatchRpc(rpc, tools, serverInfo, {
        ...freshCtx,
        signal: aborter.signal,
      });
      if (aborter.signal.aborted) return; // 连接已断 → 不写死连接
      if ('result' in response) {
        sendJson(res, 200, formatRpcResult(rpc.id, response.result));
      } else {
        sendJson(
          res,
          200,
          formatRpcError(
            rpc.id,
            response.error.code,
            response.error.message,
            response.error.data,
          ),
        );
      }
    } finally {
      req.off('close', onClose);
      res.off('close', onClose);
    }
  };

  const handleSse = (req: IncomingMessage, res: ServerResponse): void => {
    const ctx = host.verifyAndResolveCtx(req.headers['authorization']);
    if (!ctx) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    // 边界(E232):SSE 连接数量双闸,建连前查全局 + per-token,超限 429 拒(不建连、不起 keepalive、
    // 不入 sseClients),防持合法 token 的本地客户端反复打开海量长连接耗尽 main 资源。
    const token = ctx.callerSubject ?? null;
    let perTokenCount = 0;
    for (const meta of sseClients.values()) {
      if (meta.token === token) perTokenCount += 1;
    }
    if (!sseAdmissionAllowed(sseClients.size, perTokenCount)) {
      res.statusCode = 429;
      res.end('too many connections');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: ready\ndata: {"protocol":"continuo-mcp/0.1"}\n\n`);
    const keepalive = setInterval(() => {
      try {
        res.write(`: keepalive\n\n`);
      } catch {
        /* connection 已断,close 事件会清理 */
      }
    }, SSE_KEEPALIVE_MS);
    // race(R76):记 windowId + token,供 revokeToken/revokeWindowTokens 精确关闭本连接。
    sseClients.set(res, {
      windowId: ctx.ownerWindowId,
      token, // 边界(E232):复用上面准入判定算出的 token
      keepalive,
    });
    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  };

  const server: HttpServer = createHttpServer((req, res) => {
    // DNS rebinding / 跨源防护(纵深防御,token 仍是主防线 —— 审计 V6):
    // 本地 agent CLI 直连 127.0.0.1/localhost 且不带 Origin;浏览器发起的请求
    // (含 DNS rebinding:把攻击者域名解析到 127.0.0.1)一定带 Origin,且 Host
    // 为攻击者域名。拒带 Origin 的请求 + 校验 Host 必须是本机回环地址,即可挫败
    // 所有浏览器/rebinding 发起的访问。
    const addr0 = server.address();
    const boundPort =
      addr0 && typeof addr0 !== 'string' ? addr0.port : 0;
    if (
      req.headers.origin !== undefined ||
      !isLoopbackHostHeader(req.headers.host, boundPort)
    ) {
      res.statusCode = 403;
      res.end();
      return;
    }
    // 边界(E295):req.url 超长 → 414(URI Too Long),不进解析;否则去 query 取 path(纯函数 + indexOf/slice)。
    const { tooLong, path } = parseHttpRequestTarget(req.url);
    if (tooLong) {
      res.statusCode = 414;
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/mcp') {
      void handleMessage(req, res).catch((err) => {
         
        console.warn('[mcp-host] /mcp POST handler threw', err);
        if (!res.headersSent) sendJson(res, 500, '{"error":"internal"}');
      });
      return;
    }
    if (req.method === 'GET' && path === '/mcp') {
      handleSse(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, bindAddr, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('MCP host: failed to obtain server address');
  }
  const port = addr.port;

  const host: McpHost = {
    port,
    url: `http://${bindAddr}:${port}/mcp`,
    issueWindowToken(windowId: number): string {
      const tok = generateToken();
      windowTokens.set(tok, windowId);
      return tok;
    },
    revokeToken(token: string): void {
      windowTokens.delete(token);
      // race(R76):同步关闭该 token 已建立的 SSE 连接,否则撤销后旧 client 仍 keepalive +
      // 继续收 broadcast(stale 连接 + interval 泄漏)。
      for (const [res, meta] of [...sseClients]) {
        if (meta.token === token) closeSseClient(res);
      }
    },
    revokeWindowTokens(windowId: number): void {
      for (const [tok, wid] of windowTokens) {
        if (wid === windowId) windowTokens.delete(tok);
      }
      // race(R76):关闭该 window 所有 SSE 连接(同 revokeToken)。
      for (const [res, meta] of [...sseClients]) {
        if (meta.windowId === windowId) closeSseClient(res);
      }
    },
    resolveWindowId(token: string): number | null {
      return windowTokens.get(token) ?? null;
    },
    verifyAndResolveCtx(authHeader: string | undefined): McpCallCtx | null {
      if (!authHeader) return null;
      const m = /^bearer (.+)$/i.exec(authHeader);
      if (!m) return null;
      const token = m[1];
      if (!token) return null;
      const wid = windowTokens.get(token);
      if (typeof wid !== 'number') return null;
      // 安全 S3:bearer token 即调用方身份(callerSubject),供 capability 校验用。
      return { ownerWindowId: wid, callerSubject: token };
    },
    tools,
    serverInfo,
    registerTool(tool: AnyMcpTool): void {
      tools.set(tool.name, tool);
    },
    removeTool(name: string): void {
      tools.delete(name);
    },
    broadcast(method: string, params?: Record<string, unknown>): void {
      // SSE event 格式:`data: <json>\n\n`(双 \n 表示 event 结束).
      // notification 是 JSON-RPC 2.0 无 id 形态.
      const payload: Record<string, unknown> = { jsonrpc: '2.0', method };
      if (params !== undefined) payload.params = params;
      const line = `data: ${JSON.stringify(payload)}\n\n`;
      const dead: ServerResponse[] = [];
      for (const c of sseClients.keys()) {
        try {
          c.write(line);
        } catch {
          dead.push(c);
        }
      }
      for (const c of dead) closeSseClient(c);
    },
    rotateToken(): void {
      windowTokens.clear();
      // 踢断所有现有 SSE 连接(它们持的旧 token 已无效)+ 清各自 keepalive interval。
      for (const [res, meta] of sseClients) {
        clearInterval(meta.keepalive);
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
    },
    async close(): Promise<void> {
      for (const [res, meta] of sseClients) {
        clearInterval(meta.keepalive);
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return host;
}
