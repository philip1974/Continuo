// Stdio MCP transport server(P4+ C 方案)。
// macOS/Linux 走 unix socket(文件权限 0600 = capability 鉴权,无 token);
// CLI proxy(scripts/continuo-mcp-stdio.mjs)由 Claude Code spawn,
// 通过 stdin/stdout 与本 server 走 NDJSON。
//
// 优势:Claude Code mcp 配置只存 spawn 命令路径,无 token,无端口,
// Continuo 重启 token rotate 不影响,一次配置永久使用。
//
// Windows 留 TODO(named pipe 路径不同,API 一致)。
//
// BDD: src/__tests__/agent-terminal-mcp-stdio-framing/(framing 纯函数)
// HTTP server 行为不复用本主题,留 E2E。

import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { BrowserWindow } from 'electron';
import { mkdir, unlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  RPC_ERROR_CODES,
  NO_WINDOW_CTX_MESSAGE,
  parseRpcMessage,
  formatRpcResult,
  formatRpcError,
  dispatchRpc,
  type AnyMcpTool,
  type McpCallCtx,
  type ServerInfo,
} from './mcp-host.service';

// ── NDJSON framing(纯函数,BDD 测试)─────────────────────────────

export interface FramingState {
  readonly buf: string;
}

export interface SplitResult {
  readonly state: FramingState;
  readonly lines: readonly string[];
}

/**
 * 累积 chunk + 按 \n 切行。残行(无 \n 终止)保留在新 state.buf 给下次。
 * 不 mutate 入参 state(返回新对象)。
 */
export function splitLines(state: FramingState, chunk: string): SplitResult {
  const combined = state.buf + chunk;
  if (combined.length === 0) {
    return { state: { buf: '' }, lines: [] };
  }
  const parts = combined.split('\n');
  // split 后最后一段是残行(没遇到 \n 的尾巴);若 combined 末尾是 \n,最后一段是 ''
  const tail = parts.pop() ?? '';
  return { state: { buf: tail }, lines: parts };
}

// ── socket server ──────────────────────────────────────────────

const socketCtx: Map<Socket, number> = new Map();

export interface StdioSocketServer {
  readonly socketPath: string;
  /**
   * 推 JSON-RPC notification(无 id)给所有 stdio 客户端.
   * 写入失败的 socket 自动摘掉.
   */
  broadcast(method: string, params?: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface CreateStdioSocketOptions {
  socketPath: string;
   
  tools: ReadonlyMap<string, AnyMcpTool>;
  serverInfo: ServerInfo;
}

async function handleLine(
  line: string,
  sock: Socket,
   
  tools: ReadonlyMap<string, AnyMcpTool>,
  serverInfo: ServerInfo,
): Promise<void> {
  if (!line.trim()) return;

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    sock.write(
      formatRpcError(null, RPC_ERROR_CODES.PARSE_ERROR, 'parse error') + '\n',
    );
    return;
  }

  // Continuo private notification:proxy sends caller BrowserWindow context
  // before normal MCP traffic. Must be consumed before generic notification
  // discard below.
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>)['jsonrpc'] === '2.0' &&
    (raw as Record<string, unknown>)['method'] === '_continuo/hello' &&
    !('id' in (raw as Record<string, unknown>))
  ) {
    const params = (raw as Record<string, unknown>)['params'];
    const windowId =
      params !== null &&
      typeof params === 'object' &&
      !Array.isArray(params)
        ? (params as Record<string, unknown>)['windowId']
        : undefined;
    if (typeof windowId !== 'number' || !Number.isInteger(windowId)) return;
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) return;
    socketCtx.set(sock, windowId);
    return;
  }

  // notification(无 id)→ 不响应(202 等价语义,stdio 直接 silent)
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>)['jsonrpc'] === '2.0' &&
    typeof (raw as Record<string, unknown>)['method'] === 'string' &&
    !('id' in (raw as Record<string, unknown>))
  ) {
    return;
  }

  const rpc = parseRpcMessage(raw);
  if (!rpc) {
    sock.write(
      formatRpcError(
        null,
        RPC_ERROR_CODES.PARSE_ERROR,
        'invalid JSON-RPC 2.0',
      ) + '\n',
    );
    return;
  }

  const ownerWindowId = socketCtx.get(sock);
  const ctx: McpCallCtx | null =
    typeof ownerWindowId === 'number' ? { ownerWindowId } : null;
  const response = await dispatchRpc(rpc, tools, serverInfo, ctx);
  if ('result' in response) {
    sock.write(formatRpcResult(rpc.id, response.result) + '\n');
  } else {
    sock.write(
      formatRpcError(
        rpc.id,
        response.error.code,
        response.error.code === RPC_ERROR_CODES.NO_WINDOW_CTX
          ? NO_WINDOW_CTX_MESSAGE
          : response.error.message,
        response.error.data,
      ) + '\n',
    );
  }
}

/**
 * 启动 stdio MCP socket server。
 *
 * - macOS / Linux:Unix socket(`<userData>/mcp.sock`)— 文件系统 +
 *   chmod 0600 = capability 鉴权。
 * - Windows:named pipe(`\\.\pipe\continuo-mcp`)— 不在文件系统,
 *   无 mkdir / unlink / chmod。Win NT pipe ACL 默认只本用户可访问。
 *
 * net 模块 API 跨平台一致,只在 fs 副作用上分支。
 */
export async function createStdioSocketServer(
  opts: CreateStdioSocketOptions,
): Promise<StdioSocketServer> {
  const isWin = process.platform === 'win32';

  if (!isWin) {
    await mkdir(path.dirname(opts.socketPath), { recursive: true });
    if (existsSync(opts.socketPath)) {
      try {
        await unlink(opts.socketPath);
      } catch {
        /* ignore — listen 会再报错 */
      }
    }
  }

  const clients = new Set<Socket>();

  const server: NetServer = createNetServer((sock) => {
    clients.add(sock);
    let state: FramingState = { buf: '' };
    sock.on('data', (chunk: Buffer) => {
      const r = splitLines(state, chunk.toString('utf8'));
      state = r.state;
      // 异步串行处理(每行 dispatch 可能 await tool.run)。
      // 简化:并行 fire-and-forget,客户端按 id 匹配响应。
      for (const line of r.lines) {
        void handleLine(line, sock, opts.tools, opts.serverInfo).catch((err) => {
           
          console.warn('[mcp-stdio] handleLine threw', err);
        });
      }
    });
    sock.on('close', () => {
      clients.delete(sock);
      socketCtx.delete(sock);
    });
    sock.on('error', () => {
      /* connection error,close 事件会清理 */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  if (!isWin) {
    // 显式 chmod 0600(unix socket 默认 umask 通常 0666 太宽)
    try {
      await chmod(opts.socketPath, 0o600);
    } catch {
      /* macOS 上偶尔不需要,忽略 */
    }
  }

  return {
    socketPath: opts.socketPath,
    broadcast(method: string, params?: Record<string, unknown>): void {
      const payload: Record<string, unknown> = { jsonrpc: '2.0', method };
      if (params !== undefined) payload.params = params;
      const line = JSON.stringify(payload) + '\n';
      const dead: Socket[] = [];
      for (const c of clients) {
        try {
          c.write(line);
        } catch {
          dead.push(c);
        }
      }
      for (const c of dead) clients.delete(c);
    },
    async close(): Promise<void> {
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!isWin) {
        try {
          await unlink(opts.socketPath);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
