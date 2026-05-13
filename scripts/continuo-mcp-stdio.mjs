#!/usr/bin/env node
// Continuo MCP — stdio transport proxy (P4+)。
// 由 Claude Code(或其它 MCP client)spawn,通过 stdin/stdout 与之走 NDJSON。
// 本 proxy 不解析协议,只是把字节流转发给 Continuo 主进程的 unix socket。
//
// 用法(配置一次,永久使用):
//   claude mcp add --transport stdio continuo -- /path/to/continuo-mcp-stdio.mjs
//
// socket 路径优先级:
//   1. CONTINUO_MCP_SOCKET 环境变量
//   2. 默认(与 main 的 resolveStdioSocketPath 对齐):
//      macOS = ~/Library/Application Support/Continuo/mcp.sock
//      Linux = $XDG_CONFIG_HOME/Continuo/mcp.sock 或 ~/.config/Continuo/mcp.sock
//      Windows = \\.\pipe\continuo-mcp(named pipe,不在文件系统)
//
// Continuo 主进程必须在线;否则连失败,Claude Code 标 mcp server 不可用。

import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function defaultSocketPath() {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Continuo',
      'mcp.sock',
    );
  }
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\continuo-mcp';
  }
  // Linux:fallback ~/.config/Continuo
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'Continuo', 'mcp.sock');
}

const socketPath = process.env.CONTINUO_MCP_SOCKET ?? defaultSocketPath();
// CONTINUO_WINDOW_ID 由 Continuo PTY env provider 注入(per-window 隔离);若
// 缺失说明 proxy 是外部 spawn(eg. Claude Code `claude mcp add` 配置),不属于
// 任何 Continuo window 上下文 — 不发 hello,server 端会 fallback 到默认主窗。
const CONTINUO_WINDOW_ID = process.env.CONTINUO_WINDOW_ID;
const windowId =
  CONTINUO_WINDOW_ID && /^\d+$/.test(CONTINUO_WINDOW_ID)
    ? Number(CONTINUO_WINDOW_ID)
    : null;

// existsSync 在 Windows named pipe 上不工作(不在文件系统),跳过预检;
// macOS/Linux 仍预检以给清晰错误,避免连接异常时报模糊网络错误。
if (process.platform !== 'win32' && !existsSync(socketPath)) {
  process.stderr.write(
    `[continuo-mcp-stdio] socket not found: ${socketPath}\n` +
      '  Continuo app appears not to be running. Start Continuo first.\n',
  );
  process.exit(1);
}

const sock = createConnection(socketPath, () => {
  if (windowId !== null) {
    // 有 windowId env → 发 hello 绑定 per-window ctx(Continuo 内部 PTY 路径)
    const hello =
      JSON.stringify({
        jsonrpc: '2.0',
        method: '_continuo/hello',
        params: { windowId },
      }) + '\n';
    sock.write(hello);
  }
  // 无 windowId → 跳过 hello;server 端 tools/call 会 fallback 到默认主窗
  // (外部 MCP client 如 Claude Code 的 stdio 配置走此路径)

  // stdin → socket(byte 流透传,framing 由两端按 NDJSON 自管)
  process.stdin.pipe(sock);
});

sock.on('error', (err) => {
  process.stderr.write(
    `[continuo-mcp-stdio] socket error: ${err.message}\n`,
  );
  process.exit(1);
});

sock.on('close', () => {
  // socket 关闭(Continuo 退出)→ 客户端会发现 stdout EOF
  process.exit(0);
});

// socket → stdout(同)
sock.pipe(process.stdout);

process.on('SIGINT', () => sock.end());
process.on('SIGTERM', () => sock.end());
