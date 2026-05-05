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

// ── 常量 ────────────────────────────────────────────────────────

/** JSON-RPC 2.0 标准 + 自定义错误码. */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  /** 自定义,落在 JSON-RPC 实现保留区(-32000 ~ -32099). */
  UNAUTHORIZED: -32001,
} as const;

const LOCALHOST_ADDRS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
]);

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

  const id = obj['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return null;

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

// ── createMcpHost(HTTP wiring,留 E2E)──────────────────────────

export interface McpToolDef<I = unknown, O = unknown> {
  readonly name: string;
  readonly inputSchema: z.ZodType<I>;
  readonly run: (input: I) => O | Promise<O>;
}

// host 内部统一用 any generic — 它只 dispatch,不关心 tool 的具体 I/O 形态。
// 各 tool 自己用 McpToolDef<I, O> 保留外部强类型。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMcpTool = McpToolDef<any, any>;

export interface McpHost {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  registerTool(tool: AnyMcpTool): void;
  rotateToken(): string;
  close(): Promise<void>;
}

export interface McpHostOptions {
  bindAddr?: string;
  port?: number;
  initialTools?: ReadonlyArray<AnyMcpTool>;
}

const MAX_BODY_BYTES = 1_000_000; // 1MB,防 body bomb
const SSE_KEEPALIVE_MS = 25_000;   // SSE 心跳,防中间件 idle 断

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'PAYLOAD_TOO_LARGE' }));
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
      code: 'MCP_HOST_BIND_FORBIDDEN',
    });
  }

  const tools = new Map<string, AnyMcpTool>();
  for (const t of options.initialTools ?? []) tools.set(t.name, t);

  let token = generateToken();
  const sseClients = new Set<ServerResponse>();

  const handleMessage = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (!verifyBearer(req.headers['authorization'], token)) {
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

    const rpc = parseRpcMessage(raw);
    if (!rpc) {
      sendJson(
        res,
        200,
        formatRpcError(null, RPC_ERROR_CODES.PARSE_ERROR, 'invalid JSON-RPC 2.0'),
      );
      return;
    }

    const tool = tools.get(rpc.method);
    if (!tool) {
      sendJson(
        res,
        200,
        formatRpcError(
          rpc.id,
          RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `method not found: ${rpc.method}`,
        ),
      );
      return;
    }

    const parsed = tool.inputSchema.safeParse(rpc.params);
    if (!parsed.success) {
      sendJson(
        res,
        200,
        formatRpcError(
          rpc.id,
          RPC_ERROR_CODES.INVALID_PARAMS,
          parsed.error.issues.map((i) => i.message).join('; '),
        ),
      );
      return;
    }

    try {
      const result = await tool.run(parsed.data);
      sendJson(res, 200, formatRpcResult(rpc.id, result));
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      const message =
        typeof e.message === 'string' ? e.message : 'internal error';
      sendJson(
        res,
        200,
        formatRpcError(rpc.id, -32603, message, {
          code: typeof e.code === 'string' ? e.code : undefined,
        }),
      );
    }
  };

  const handleSse = (req: IncomingMessage, res: ServerResponse): void => {
    if (!verifyBearer(req.headers['authorization'], token)) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: ready\ndata: {"protocol":"continuo-mcp/0.1"}\n\n`);
    sseClients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(`: keepalive\n\n`);
      } catch {
        /* connection 已断,close 事件会清理 */
      }
    }, SSE_KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  };

  const server: HttpServer = createHttpServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/message') {
      void handleMessage(req, res).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[mcp-host] /message handler threw', err);
        if (!res.headersSent) sendJson(res, 500, '{"error":"internal"}');
      });
      return;
    }
    if (req.method === 'GET' && url === '/sse') {
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
    url: `http://${bindAddr}:${port}/sse`,
    get token() {
      return token;
    },
    registerTool(tool: AnyMcpTool): void {
      tools.set(tool.name, tool);
    },
    rotateToken(): string {
      token = generateToken();
      // 踢断所有现有 SSE 连接(它们持的旧 token 已无效)
      for (const c of sseClients) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      return token;
    },
    async close(): Promise<void> {
      for (const c of sseClients) {
        try {
          c.end();
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
