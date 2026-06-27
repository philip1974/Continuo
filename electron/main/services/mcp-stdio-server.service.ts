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
import * as crypto from 'node:crypto';
import { mkdir, unlink, chmod, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPopoutUrl } from '../popout-url';
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
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { createNdjsonLineDecoder } from '../lib/ndjson-line-decoder';

export interface ResolveStdioHelloDeps {
  resolveWindowId: (token: string) => number | null;
  windowExists: (windowId: number) => boolean;
}

// 边界(E297,E252 同一 stdio hello payload 兄弟字段):hello token 长度上限。host token 由 generateToken
// 生成(32 字节 base64url = 43 字符),合法 token 远短于此。此前 token 仅非空校验,无上限 → 不可信 stdio
// client 可在 1MB 行内塞超长 token,经 resolveWindowId(Map.get/比较)放大 CPU/内存。超限直接 null。
const MAX_HELLO_TOKEN_LEN = 256;

export function hasOversizedStdioLine(
  lines: readonly string[],
  maxBytes: number,
): boolean {
  for (const line of lines) {
    if (utf8BytesExceed(line, maxBytes)) return true;
  }
  return false;
}

export function resolveStdioHelloWindowId(
  params: unknown,
  deps: ResolveStdioHelloDeps,
): number | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return null;
  }
  const windowId = (params as Record<string, unknown>)['windowId'];
  const token = (params as Record<string, unknown>)['token'];
  // 边界(E252):windowId 须**安全整数且非负**(对齐 AttachTargetSchema.windowId nonnegative()
  // .max(MAX_SAFE_INTEGER))。此前仅 Number.isInteger —— 挡 NaN/Infinity/小数,但放行 -1 / 2^53+1 这类
  // 负数/不安全整数,经 resolveWindowId !== / windowExists 判定时(数组索引 / Electron fromId)可能精度
  // 碰撞或误探窗口。外部 stdio hello payload 不可信,收口为安全非负整数。
  if (
    typeof windowId !== 'number' ||
    !Number.isSafeInteger(windowId) ||
    windowId < 0
  ) {
    return null;
  }
  // 边界(E297):token 非空且 ≤ MAX_HELLO_TOKEN_LEN(超长不可信 → null,不进 resolveWindowId)。
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_HELLO_TOKEN_LEN
  )
    return null;
  if (deps.resolveWindowId(token) !== windowId) return null;
  if (!deps.windowExists(windowId)) return null;
  return windowId;
}

export interface ResolveStdioCallCtxDeps {
  /** 绑定窗口是否存活(BrowserWindow.fromId(id) 非 null 且未 destroyed)。 */
  isWindowAlive: (windowId: number) => boolean;
}

/**
 * 解析 tools/call 的 owner 窗口:仅当绑定窗口仍存活才返回它;未绑定(undefined)
 * 或绑定窗口已关闭一律返回 null,交给调用方 fallback 到当前活窗。
 *
 * 必须在每次 dispatch 时校验存活 —— socketCtx 在 hello 时一次性绑定、窗口关闭
 * 清理不会移除它,陈旧绑定若直接使用会让该 proxy 连接对所有工具永久损坏。
 */
export function resolveStdioCallOwnerWindow(
  ownerWindowId: number | undefined,
  deps: ResolveStdioCallCtxDeps,
): number | null {
  if (typeof ownerWindowId !== 'number') return null;
  if (!deps.isWindowAlive(ownerWindowId)) return null;
  return ownerWindowId;
}

// ── socket server ──────────────────────────────────────────────

const socketCtx: Map<Socket, number> = new Map();

// 边界(E1):stdio NDJSON 单行/残行字节上限。畸形/恶意本地客户端发送无换行的超长输入会让
// 行解码器(E135 createNdjsonLineDecoder)的残行 buffer 在 main 进程无限累积 → 内存增长甚至 OOM(HTTP MCP 有
// MAX_BODY_BYTES,stdio 传输此前缺同等保护)。超限即回 parse 错误并断开连接。与 HTTP 的
// MAX_BODY_BYTES(1MB)对齐 —— 单条 JSON-RPC 行 1MB 对正常 tools/call 充裕。
const MAX_STDIO_LINE_BYTES = 1_000_000;
// 边界(E214):单次 data chunk 解出的**非空行数**上限。MAX_STDIO_LINE_BYTES 只限单行字节,不限行数 ——
// 畸形/恶意客户端可发 1MB 的 `\n\n\n...` 或海量极短 JSON 行(每行都不超字节上限),for...of 会为每行挂
// promise + 持有 line 字符串 → CPU/内存放大。空白行(NDJSON 约定忽略,handleLine 本就早返)入链前同步跳过;
// 非空行数超此预算 → parse error + 断开。1024 远超任何正常批量(MCP client 通常一行一请求)。
const MAX_STDIO_LINES_PER_CHUNK = 1024;

// 边界(E233,E227-E232 数量上限族):stdio MCP socket server 并发连接数量上限。每条连接保留 Socket +
// AbortController + 行解码器闭包 + clients/lineChains/aborters/socketCtx/socketSubject 多个 Map/Set 条目,
// 只在 close 才清。socket 受 chmod 0600 / NT pipe ACL 限本用户,但**本用户任意进程**可反复连接
// <userData>/mcp.sock 保持空闲 → main 累积 fd / 内存 + broadcast() 对全部连接线性写入 → 资源耗尽 + 通知
// 广播拖慢。connection 回调入口加全局上限(连接建立时 subject/window 尚未解析,只能全局闸),超限立即写
// 错误 + sock.destroy(),确保不进入任何 clients/aborters/lineChains 表。
const MAX_STDIO_CLIENTS_GLOBAL = 64; // 全局 stdio 连接上限(远超任何正常 MCP client 并发)

// 安全 S3:每个 stdio 连接一个稳定 subject(callerSubject)。Claude Code 的 proxy
// 一次 spawn 长连接复用 → 同一连接的 create_session 与 read/send 共享 subject;
// 不同连接(含恶意进程直连 mcp.sock,unix socket 0600 仅本用户但 postinstall 也是本
// 用户)subject 不同 → 无法读控别连接创建的会话。HTTP 侧 subject=bearer token。
const socketSubject: Map<Socket, string> = new Map();
function subjectForSocket(sock: Socket): string {
  let s = socketSubject.get(sock);
  if (s === undefined) {
    s = `stdio:${crypto.randomUUID()}`;
    socketSubject.set(sock, s);
  }
  return s;
}

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
  resolveWindowId: (token: string) => number | null;
}

function modeOct(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

export async function setupSocketDir(socketPath: string): Promise<void> {
  const parentDir = path.dirname(socketPath);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });

  let parentStat = await stat(parentDir);
  if ((parentStat.mode & 0o077) !== 0) {
    const previous = modeOct(parentStat.mode);
    await chmod(parentDir, 0o700);
    parentStat = await stat(parentDir);
    console.warn(
      `[mcp-stdio] tightened socket parent directory mode ${previous} -> 0700: ${parentDir}`,
    );
    if ((parentStat.mode & 0o077) !== 0) {
      throw new Error(
        `mcp stdio socket parent remains group/world accessible after chmod: ${parentDir} (${modeOct(parentStat.mode)})`,
      );
    }
  }

  try {
    const existing = await lstat(socketPath);
    if (existing.isSymbolicLink()) {
      throw new Error(`mcp stdio socket path is a symlink; remove it manually: ${socketPath}`);
    }
    if (existing.isSocket()) {
      await unlink(socketPath);
      return;
    }
    if (existing.isFile() && existing.size === 0) {
      await unlink(socketPath);
      console.warn(`[mcp-stdio] removed zero-size stale socket placeholder: ${socketPath}`);
      return;
    }
    throw new Error(
      `mcp stdio socket path exists and is not a stale socket. Remove it manually: ${socketPath}`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

async function handleLine(
  line: string,
  sock: Socket,
  tools: ReadonlyMap<string, AnyMcpTool>,
  serverInfo: ServerInfo,
  resolveWindowId: (token: string) => number | null,
  signal: AbortSignal,
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
    const windowId = resolveStdioHelloWindowId(
      (raw as Record<string, unknown>)['params'],
      {
        resolveWindowId,
        windowExists: (id) => {
          const win = BrowserWindow.fromId(id);
          return !!win && !win.isDestroyed();
        },
      },
    );
    if (windowId === null) return;
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

  // 绑定的窗口可能已关闭:窗口关闭清理(revokeWindowTokens/cancelByWindow)不触碰
  // socketCtx,而 socket 仍连着(proxy 进程没退)。若直接用已死的 windowId,所有
  // tools/call 会撞 TERMINAL_NO_WINDOW/SESSION_NOT_FOUND,该 proxy 连接对所有工具
  // 永久损坏(即使别的窗口活着)。resolveStdioCallOwnerWindow 校验绑定窗口存活,
  // 死则返回 null → 走下面的 fallback 到当前活窗。
  const liveOwner = resolveStdioCallOwnerWindow(socketCtx.get(sock), {
    isWindowAlive: (id) => {
      const w = BrowserWindow.fromId(id);
      return w !== null && !w.isDestroyed();
    },
  });
  // 安全 S3:无论绑定窗口还是 fallback,都带本连接的 callerSubject,供 capability 校验。
  const callerSubject = subjectForSocket(sock);
  // race(R111):本次调用带连接取消信号,供有副作用工具在授权 await 后复查(socket close 即 abort)。
  let ctx: McpCallCtx | null =
    liveOwner !== null ? { ownerWindowId: liveOwner, callerSubject, signal } : null;
  // Fallback:外部 MCP client(eg. Claude Code stdio 配置)spawn 的 proxy
  // 无 CONTINUO_WINDOW_ID env,不发 hello,socketCtx 空 → fallback 到第一个
  // 非 popout 主窗。mirror agent-auth.pickMainWindow 策略。tools/list 无需 ctx
  // (dispatchRpc 自行短路),只有 tools/call 路径需要。
  if (ctx === null) {
    const wins = BrowserWindow.getAllWindows();
    let fallback: BrowserWindow | null = null;
    for (const w of wins) {
      if (w.isDestroyed()) continue;
      if (!isPopoutUrl(w.webContents.getURL())) {
        fallback = w;
        break;
      }
    }
    if (!fallback) fallback = wins.find((w) => !w.isDestroyed()) ?? null;
    if (fallback) ctx = { ownerWindowId: fallback.id, callerSubject, signal };
  }
  const response = await dispatchRpc(rpc, tools, serverInfo, ctx);
  // race(R111):连接已断开(close)→ 不把响应写回死 socket(避免 EPIPE / 写给无调用方的会话)。
  if (sock.destroyed) return;
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
    await setupSocketDir(opts.socketPath);
  }

  const clients = new Set<Socket>();
  // race(R110):每连接一条行处理链。同一 stdio socket 的多行 JSON-RPC 必须**按接收顺序串行**
  // 执行 —— 并行 fire-and-forget 下有副作用的工具会乱序:terminal.send_text 紧跟
  // terminal.press_key 时,Enter 可能先于文本写入 PTY,agent 命令输入错乱(响应按 id 匹配只
  // 修复返回值配对,修不了副作用顺序)。close 时清链防泄漏。
  const lineChains = new Map<Socket, Promise<void>>();
  // race(R111):每连接一个 AbortController。socket close 时 abort → 在途 tool call(尤其卡在用户
  // 授权 await 的 create_session)在产生副作用前复查 ctx.signal,已取消则拒绝,不留无调用方孤儿会话。
  const aborters = new Map<Socket, AbortController>();

  const server: NetServer = createNetServer((sock) => {
    // 边界(E233):全局连接数上限,超限立即写错误 + destroy,不入 clients/aborters/lineChains。
    // 连接建立时 subject/window 未知,只能全局闸(per-subject 在 per-message 才解析)。
    if (clients.size >= MAX_STDIO_CLIENTS_GLOBAL) {
      try {
        sock.write(
          formatRpcError(
            null,
            RPC_ERROR_CODES.PARSE_ERROR,
            'too many connections',
          ) + '\n',
        );
      } catch {
        /* 连接可能已坏,destroy 兜底 */
      }
      sock.destroy();
      return;
    }
    clients.add(sock);
    const aborter = new AbortController();
    aborters.set(sock, aborter);
    // 边界(E135,E131/E132 同族):用流式 TextDecoder 行解码器,跨 chunk 多字节字符正确还原
    //(替代 splitLines 的逐 chunk toString() 拆字 bug)。
    const lineDecoder = createNdjsonLineDecoder();
    sock.on('data', (chunk: Buffer) => {
      // 边界(E218,E214 下推):行数上限下推到 decoder —— maxLines 钳定本次产出的完整行数,达到即
      // overflow(decoder 不 split 全量物化)。overflow → 与 E214 too-many 同款 parse error + 断开。
      const { lines, overflow } = lineDecoder.push(
        chunk,
        MAX_STDIO_LINES_PER_CHUNK,
      );
      if (overflow) {
        try {
          sock.write(
            formatRpcError(
              null,
              RPC_ERROR_CODES.PARSE_ERROR,
              'too many lines in one chunk',
            ) + '\n',
          );
        } catch {
          /* 连接可能已坏,destroy 兜底 */
        }
        sock.destroy();
        return;
      }
      // 边界(E1):残行(未终结的单行)或任一完整行超字节上限 → 畸形/恶意客户端无限累积输入,
      // main 进程内存增长/OOM。回 parse 错误并断开;lineChain/aborter 由 close 处理统一清理。
      // 边界(E127,E125 同族):按**真实 UTF-8 字节**判上限(非 .length=UTF-16 code unit),否则
      // CJK/emoji 大行真实字节可数倍超 1MB 仍放行/继续累积,削弱输入背压并让超大 JSON 进 parse。
      if (
        utf8BytesExceed(lineDecoder.buffered, MAX_STDIO_LINE_BYTES) ||
        hasOversizedStdioLine(lines, MAX_STDIO_LINE_BYTES)
      ) {
        try {
          sock.write(
            formatRpcError(
              null,
              RPC_ERROR_CODES.PARSE_ERROR,
              'line exceeds maximum size',
            ) + '\n',
          );
        } catch {
          /* 连接可能已坏,destroy 兜底 */
        }
        sock.destroy();
        return;
      }
      // race(R110):按接收顺序串到本 socket 的链尾,逐行串行 await。链尾 catch 后继续,单行
      // 失败/抛错不阻塞后续行(每行响应仍按 id 配对发回客户端)。
      // 边界(E214):空白行(NDJSON 忽略,handleLine 本就早返)入链前同步跳过,避免为海量空行挂 promise;
      // 非空行数超 MAX_STDIO_LINES_PER_CHUNK → parse error + 断开(挡 1MB \n\n\n... / 海量极短行放大)。
      let chained = 0;
      for (const line of lines) {
        if (line.trim() === '') continue; // 空白行:NDJSON 忽略,不入链
        chained += 1;
        if (chained > MAX_STDIO_LINES_PER_CHUNK) {
          try {
            sock.write(
              formatRpcError(
                null,
                RPC_ERROR_CODES.PARSE_ERROR,
                'too many lines in one chunk',
              ) + '\n',
            );
          } catch {
            /* 连接可能已坏,destroy 兜底 */
          }
          sock.destroy();
          return;
        }
        const prev = lineChains.get(sock) ?? Promise.resolve();
        const next = prev.then(() =>
          handleLine(
            line,
            sock,
            opts.tools,
            opts.serverInfo,
            opts.resolveWindowId,
            aborter.signal,
          ).catch((err) => {
            console.warn('[mcp-stdio] handleLine threw', err);
          }),
        );
        lineChains.set(sock, next);
      }
    });
    sock.on('close', () => {
      clients.delete(sock);
      socketCtx.delete(sock);
      socketSubject.delete(sock);
      lineChains.delete(sock);
      aborter.abort(); // race(R111):取消本连接所有在途 tool call 的副作用
      aborters.delete(sock);
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
      // 必须先 destroy 现存连接:server.close() 的回调要等所有现存连接关闭才触发,
      // 只 clients.clear() 不 destroy → 有活动客户端时回调永不 fire,close() promise
      // 永久挂起,socket 文件也来不及 unlink 残留(审计 P2)。
      for (const sock of clients) {
        try {
          sock.destroy();
        } catch {
          /* 已断开 → 忽略 */
        }
        socketCtx.delete(sock);
        socketSubject.delete(sock);
      }
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

// 边界(E233)测试用:全局 stdio 连接上限常量。
export const MAX_STDIO_CLIENTS_GLOBAL_FOR_TEST = MAX_STDIO_CLIENTS_GLOBAL;
