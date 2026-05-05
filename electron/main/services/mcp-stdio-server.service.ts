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
import { mkdir, unlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  RPC_ERROR_CODES,
  parseRpcMessage,
  formatRpcResult,
  formatRpcError,
  dispatchRpc,
  type AnyMcpTool,
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

export interface StdioSocketServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface CreateStdioSocketOptions {
  socketPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ReadonlyMap<string, AnyMcpTool>;
  serverInfo: ServerInfo;
}

async function handleLine(
  line: string,
  sock: Socket,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  const response = await dispatchRpc(rpc, tools, serverInfo);
  if ('result' in response) {
    sock.write(formatRpcResult(rpc.id, response.result) + '\n');
  } else {
    sock.write(
      formatRpcError(
        rpc.id,
        response.error.code,
        response.error.message,
        response.error.data,
      ) + '\n',
    );
  }
}

/**
 * 启动 unix socket server。Windows 走 named pipe(本期 TODO,直接 throw)。
 *
 * 调用者需保证 socketPath 父目录可写;本函数会:
 *   1. mkdir -p 父目录
 *   2. unlink 旧 socket 文件(若存在)
 *   3. listen → chmod 0600
 */
export async function createStdioSocketServer(
  opts: CreateStdioSocketOptions,
): Promise<StdioSocketServer> {
  if (process.platform === 'win32') {
    throw Object.assign(
      new Error('stdio MCP transport on Windows not yet implemented'),
      { code: 'STDIO_WIN32_TODO' },
    );
  }

  await mkdir(path.dirname(opts.socketPath), { recursive: true });
  if (existsSync(opts.socketPath)) {
    try {
      await unlink(opts.socketPath);
    } catch {
      /* ignore — listen 会再报错 */
    }
  }

  const server: NetServer = createNetServer((sock) => {
    let state: FramingState = { buf: '' };
    sock.on('data', (chunk: Buffer) => {
      const r = splitLines(state, chunk.toString('utf8'));
      state = r.state;
      // 异步串行处理(每行 dispatch 可能 await tool.run)。
      // 简化:并行 fire-and-forget,客户端按 id 匹配响应。
      for (const line of r.lines) {
        void handleLine(line, sock, opts.tools, opts.serverInfo).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[mcp-stdio] handleLine threw', err);
        });
      }
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

  // 显式 chmod 0600(unix socket 默认 umask 通常 0666 太宽)
  try {
    await chmod(opts.socketPath, 0o600);
  } catch {
    /* macOS 上偶尔不需要,忽略 */
  }

  return {
    socketPath: opts.socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await unlink(opts.socketPath);
      } catch {
        /* ignore */
      }
    },
  };
}
