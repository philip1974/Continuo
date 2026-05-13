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
const CONTINUO_WINDOW_ID = process.env.CONTINUO_WINDOW_ID;
if (!CONTINUO_WINDOW_ID || !/^\d+$/.test(CONTINUO_WINDOW_ID)) {
  process.stderr.write(
    'continuo-mcp-stdio: missing or invalid CONTINUO_WINDOW_ID env (must be integer)\n',
  );
  process.exit(1);
}
const windowId = Number(CONTINUO_WINDOW_ID);

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
  const hello =
    JSON.stringify({
      jsonrpc: '2.0',
      method: '_continuo/hello',
      params: { windowId },
    }) + '\n';
  sock.write(hello);
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
