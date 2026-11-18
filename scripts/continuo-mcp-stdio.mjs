#!/usr/bin/env node
// Continuo MCP — stdio transport proxy (P4+)。
// 由 Claude Code(或其它 MCP client)spawn,通过 stdin/stdout 与之走 NDJSON。
// 本 proxy 不解析协议,只是把字节流转发给 Continuo 主进程的 unix socket。
//
// 用法(配置一次,永久使用):
//   claude mcp add --transport stdio continuo -- /path/to/continuo-mcp-stdio.mjs
//
// socket 路径优先级(smart fallback):
//   1. CONTINUO_MCP_SOCKET 环境变量(显式 override,最优先)
//   2. packaged.app socket(日常驱动器):
//      macOS = ~/Library/Application Support/Continuo/mcp.sock
//      Linux = $XDG_CONFIG_HOME/Continuo/mcp.sock 或 ~/.config/Continuo/mcp.sock
//   3. dev socket(packaged 没跑时 fallback):
//      macOS = ~/Library/Application Support/Continuo Dev/mcp.sock
//      Linux = ".../Continuo Dev/mcp.sock"
//   Windows = 每次启动随机的 named pipe(\\.\pipe\continuo-mcp-<用户哈希>-<随机>):
//             Continuo 终端里由 CONTINUO_MCP_SOCKET 注入;否则读发现文件
//             %APPDATA%\Continuo\mcp-pipe → %APPDATA%\Continuo Dev\mcp-pipe(只认合法名),
//             都读不到即报错退出 —— 不回落可预测名(同机其它用户可抢注同名管道骗走 hello token)
//   2/3(及 Windows 的两个发现文件)是**候选**:按序连接,连不上(崩溃残留的 socket / 过期管道名 →
//   ENOENT / ECONNREFUSED)就试下一个,全部失败才报错退出。env 显式指定时只连它,不回落。
//
// 设计:packaged 是日常工具,dev 只是临时验证。两个都活时优先 packaged
// (避免开发者忘了关 dev 误把 prod 流量打到 dev)。dev 单独活时(开发者
// 关了 packaged 起了 pnpm dev)自动落 dev。
//
// Continuo 主进程必须在线;否则连失败,Claude Code 标 mcp server 不可用。

import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function appSupportDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  // Linux:仅当 XDG_CONFIG_HOME 非空**且为绝对路径**时采用(Electron app.getPath
  // 同款语义);空字符串 / 相对路径会算出相对或错误 socket 路径,与 main 端不一致
  // → CLI proxy 连不上(跨平台审计 P2)。`??` 不拦空串,故显式判断。
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return xdg;
  return path.join(os.homedir(), '.config');
}

function packagedSocketPath() {
  return path.join(appSupportDir(), 'Continuo', 'mcp.sock');
}

function devSocketPath() {
  return path.join(appSupportDir(), 'Continuo Dev', 'mcp.sock');
}

function windowsAppDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

// Windows 管道名发现:与主进程 electron/main/services/mcp-stdio-server.service.ts 的
// isValidWindowsStdioPipeName / STDIO_PIPE_DISCOVERY_FILE 一致(本脚本独立运行不能 import)——
// 由 src/__tests__/49-polish-bugfixes/security-windows-stdio-pipe-per-user.spec.ts 钉住。
// <windows-pipe-discovery>
const WINDOWS_PIPE_NAME_RE = /^\\\\\.\\pipe\\continuo-mcp-[0-9a-f-]+$/;
function readWindowsPipeDiscovery(appDataDir) {
  // packaged 优先(日常驱动器),dev 次之;内容不是本机 continuo-mcp 管道名(被写成远程管道 / 任意路径)→ 不用。
  // 返回全部合法候选(按优先级),由调用方逐个尝试连接:packaged 文件可能是崩溃残留的过期名。
  const names = [];
  for (const appName of ['Continuo', 'Continuo Dev']) {
    let raw;
    try {
      raw = readFileSync(path.join(appDataDir, appName, 'mcp-pipe'), 'utf8');
    } catch {
      continue;
    }
    const name = raw.trim();
    if (WINDOWS_PIPE_NAME_RE.test(name)) names.push(name);
  }
  return names;
}
// </windows-pipe-discovery>

// 按序连接候选,返回第一个连上的 { sock, path };全部失败 reject(消息列出每个候选的错误)。
// 由 security-windows-stdio-pipe-per-user.spec.ts 抽出本段直接测。
// <connect-candidates>
function connectFirstCandidate(candidates, connect) {
  return new Promise((resolve, reject) => {
    const errors = [];
    const tryAt = (i) => {
      if (i >= candidates.length) {
        reject(new Error(errors.length > 0 ? errors.join('; ') : 'no candidates'));
        return;
      }
      const candidate = candidates[i];
      const sock = connect(candidate);
      const onError = (err) => {
        sock.removeListener('connect', onConnect);
        sock.destroy();
        errors.push(`${candidate}: ${err.message}`);
        tryAt(i + 1);
      };
      const onConnect = () => {
        sock.removeListener('error', onError);
        resolve({ sock, path: candidate });
      };
      sock.once('error', onError);
      sock.once('connect', onConnect);
    };
    tryAt(0);
  });
}
// </connect-candidates>

function resolveSocketCandidates() {
  if (process.env.CONTINUO_MCP_SOCKET) return [process.env.CONTINUO_MCP_SOCKET];
  if (process.platform === 'win32') return readWindowsPipeDiscovery(windowsAppDataDir());
  // existsSync 只用于筛掉明显不存在的路径(给清晰错误);存在 ≠ 有人在听,真正判定靠连接。
  return [packagedSocketPath(), devSocketPath()].filter((p) => existsSync(p));
}

const candidates = resolveSocketCandidates();
// CONTINUO_WINDOW_ID / CONTINUO_MCP_TOKEN 由 Continuo PTY env provider 注入
// (per-window 隔离);若缺失说明 proxy 是外部 spawn(eg. Claude Code
// `claude mcp add` 配置),不属于任何 Continuo window 上下文 — 不发 hello,
// server 端会 fallback 到默认主窗。
const CONTINUO_WINDOW_ID = process.env.CONTINUO_WINDOW_ID;
const CONTINUO_MCP_TOKEN = process.env.CONTINUO_MCP_TOKEN;
const windowId =
  CONTINUO_WINDOW_ID && /^\d+$/.test(CONTINUO_WINDOW_ID)
    ? Number(CONTINUO_WINDOW_ID)
    : null;

// existsSync 在 Windows named pipe 上不工作(不在文件系统),Windows 候选只来自 env / 发现文件。
if (candidates.length === 0) {
  process.stderr.write(
    (process.platform === 'win32'
      ? `[continuo-mcp-stdio] no valid pipe discovery file under ${windowsAppDataDir()}\\{Continuo,Continuo Dev}\\mcp-pipe\n`
      : `[continuo-mcp-stdio] socket not found: ${packagedSocketPath()} (nor ${devSocketPath()})\n`) +
      '  Continuo app appears not to be running. Start Continuo first (or set CONTINUO_MCP_SOCKET).\n',
  );
  process.exit(1);
}

let sock;
try {
  ({ sock } = await connectFirstCandidate(candidates, (p) => createConnection(p)));
} catch (err) {
  process.stderr.write(
    `[continuo-mcp-stdio] could not connect to Continuo: ${err.message}\n` +
      '  Continuo app appears not to be running. Start Continuo first (or set CONTINUO_MCP_SOCKET).\n',
  );
  process.exit(1);
}

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

if (windowId !== null && CONTINUO_MCP_TOKEN) {
  // 有 windowId + token env → 发 hello 绑定 per-window ctx(Continuo 内部 PTY 路径)
  const hello =
    JSON.stringify({
      jsonrpc: '2.0',
      method: '_continuo/hello',
      params: { windowId, token: CONTINUO_MCP_TOKEN },
    }) + '\n';
  sock.write(hello);
}
// 无 windowId/token → 跳过 hello;server 端 tools/call 会 fallback 到默认主窗
// (外部 MCP client 如 Claude Code 的 stdio 配置走此路径)

// stdin → socket(byte 流透传,framing 由两端按 NDJSON 自管)
process.stdin.pipe(sock);

// socket → stdout(同)
sock.pipe(process.stdout);

process.on('SIGINT', () => sock.end());
process.on('SIGTERM', () => sock.end());
