#!/usr/bin/env node
// Continuo MCP — stdio transport proxy (P4+)。
// 由 Claude Code(或其它 MCP client)spawn,通过 stdin/stdout 与之走 NDJSON。
// 本 proxy 不解析协议,只是把字节流转发给 Continuo 主进程的 unix socket。
//
// 用法(配置一次,永久使用):
//   claude mcp add --transport stdio continuo -- /path/to/continuo-mcp-stdio.mjs
//
// socket 路径优先级(smart fallback):
//   1. CONTINUO_MCP_SOCKET 环境变量(显式 override,最优先;Continuo 终端里由 PTY env 注入本实例的端点,
//      所有平台 —— dev 实例终端里的 proxy 因此连 dev 而非 packaged)
//   2. packaged.app socket(日常驱动器):
//      macOS = ~/Library/Application Support/continuo/mcp.sock
//      Linux = $XDG_CONFIG_HOME/continuo/mcp.sock 或 ~/.config/continuo/mcp.sock
//      (打包版 userData 目录名 = app.name = package.json name,小写)
//   3. dev socket(packaged 没跑时 fallback):
//      macOS = ~/Library/Application Support/Continuo Dev/mcp.sock
//      Linux = ".../Continuo Dev/mcp.sock"
//   Windows = 每次启动随机的 named pipe(\\.\pipe\continuo-mcp-<用户哈希>-<随机>):
//             Continuo 终端里由 CONTINUO_MCP_SOCKET 注入;否则读发现文件
//             %APPDATA%\continuo\mcp-pipe → %APPDATA%\Continuo Dev\mcp-pipe(内容是「管道名 + 主进程 pid」
//             两行;只认合法名,且该 pid 须仍存活 —— 崩溃残留的发现文件不用),
//             都读不到即报错退出 —— 不回落可预测名(同机其它用户可抢注同名管道骗走 hello token)
//   2/3(及 Windows 的两个发现文件)是**候选**:按序连接,连不上(崩溃残留的 socket / 过期管道名 →
//   ENOENT / ECONNREFUSED)就试下一个,全部失败才报错退出。env 显式指定时只连它,不回落(Windows 上 env
//   值须是合法本机 continuo-mcp 管道名,否则报错退出)。
//   macOS / Linux:候选先 realpath,解析后须是属于当前用户的 socket,且所在目录属于当前用户、他人不可写
//   (见 resolveTrustedPosixSocket),连接的是解析后的路径;env 指定的不满足 / 无法校验 → 报错退出
//   (不连接、不发 hello token),默认候选不满足 → 跳过。
//
// 设计:packaged 是日常工具,dev 只是临时验证。两个都活时优先 packaged
// (避免开发者忘了关 dev 误把 prod 流量打到 dev)。dev 单独活时(开发者
// 关了 packaged 起了 pnpm dev)自动落 dev。
//
// Continuo 主进程必须在线;否则连失败,Claude Code 标 mcp server 不可用。

import { createConnection } from 'node:net';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
  // 打包版 userData 目录名 = app.name = package.json name(小写;与 electron/main/user-data-path.ts 同值,规范钉住)。
  return path.join(appSupportDir(), 'continuo', 'mcp.sock');
}

function devSocketPath() {
  return path.join(appSupportDir(), 'Continuo Dev', 'mcp.sock');
}

function windowsAppDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

// Windows 管道名发现:与主进程 electron/main/services/mcp-stdio-server.service.ts 的
// isValidWindowsStdioPipeName / STDIO_PIPE_DISCOVERY_FILE / parseStdioPipeDiscovery 一致(本脚本独立运行不能
// import)—— 由 src/__tests__/49-polish-bugfixes/security-windows-stdio-pipe-per-user.spec.ts 钉住。
// <windows-pipe-discovery>
const WINDOWS_PIPE_NAME_RE = /^\\\\\.\\pipe\\continuo-mcp-[0-9a-f-]+$/;
const DISCOVERY_PID_RE = /^[1-9][0-9]{0,9}$/;
// 发现文件内容:两行「管道名 \n 主进程 pid \n」。格式不符(含只有管道名一行的旧格式)→ null。
function parseWindowsPipeDiscovery(raw) {
  const lines = raw.split('\n');
  if (lines.length === 3 && lines[2] === '') lines.pop(); // 末尾换行
  if (lines.length !== 2) return null;
  const [name, pidText] = lines;
  if (!WINDOWS_PIPE_NAME_RE.test(name) || !DISCOVERY_PID_RE.test(pidText)) return null;
  return { name, pid: Number(pidText) };
}
// 0 信号只探测进程是否存在(Windows 上 Node 同样支持)。EPERM = 存在但无权发信号 → 视为存活;
// ESRCH / 非法 pid 等其它错误 → 不存活。
function isProcessAlive(pid, probe = (p) => process.kill(p, 0)) {
  try {
    probe(pid);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}
function readWindowsPipeDiscovery(appDataDir, isAlive = isProcessAlive) {
  // packaged 优先(日常驱动器),dev 次之;内容不是本机 continuo-mcp 管道名(被写成远程管道 / 任意路径)→ 不用。
  // 返回全部合法候选(按优先级),由调用方逐个尝试连接。
  // 写入发现文件的主进程已不存活 → 跳过:Continuo 崩溃 / 被强杀后发现文件要到下次启动才删,其中的管道名可被
  // 同机其它用户在 \\.\pipe\ 下枚举并抢注,连过去会收到对方伪造的 tools/list 与工具结果。旧格式(只有管道名、
  // 没有 pid)无从验证,同样跳过(fail-closed;本脚本与 Continuo 同版本发布)。
  // 残余:崩溃后该 pid 被系统复用给别的进程(任何用户的)时这里仍判为存活,过期名照旧会被尝试 —— pid 只能
  // 证明「有这么个进程」,证明不了它是写入者。Windows 的 pid 池小、回收快,同机其它用户还可以**主动**批量起
  // 进程去占住这个 pid(无权限探测的 EPERM 也按存活处理),所以此检查只是抬高门槛(对方须同时抢注管道名并
  // 占住 pid),不是消除;根治要靠管道 ACL 或 proxy 校验服务端身份。
  const names = [];
  for (const appName of ['continuo', 'Continuo Dev']) {
    let raw;
    try {
      raw = readFileSync(path.join(appDataDir, appName, 'mcp-pipe'), 'utf8');
    } catch {
      continue;
    }
    const entry = parseWindowsPipeDiscovery(raw);
    if (entry && isAlive(entry.pid)) names.push(entry.name);
  }
  return names;
}
// CONTINUO_MCP_SOCKET env 的取值校验:Windows 上与发现文件同一规则,只认本机 continuo-mcp 管道名(env 被
// 写成远程管道 / 任意路径 → 不连,报错退出,不把 hello token 发到别处);POSIX 上 env 是任意 socket 路径,
// 名字不校验,归属由 resolveTrustedPosixSocket 校验。
function isAcceptableEnvSocket(value, platform) {
  return platform !== 'win32' || WINDOWS_PIPE_NAME_RE.test(value);
}
// </windows-pipe-discovery>

// POSIX 上候选 unix socket 的归属校验(连接、发 hello token 之前)。项目级 MCP 配置的 env 段可以把
// CONTINUO_MCP_SOCKET 指向同机其它用户监听的 socket,proxy 连上后会把窗口 token 发过去。
// 先 realpath,对**解析后的路径**校验,并让调用方**连接解析后的路径**:只校验原路径时,路径中间若有别人可改的
// 符号链接(/tmp/link/mcp.sock),校验时指向本人的 socket、连接前换成指向别人的即可绕过。要求:
//   - 解析后的路径是 socket 且属主是当前用户;
//   - 其父目录属主是当前用户且 group / other 不可写(否则他人可在校验与连接之间换掉 socket)。
// 主进程把 socket 建在 0700 的 userData 里(mcp-stdio-server.service setupSocketDir),必然满足。
// 返回 { path, error }:error 为 null → 连接 path(解析后的路径);否则 error 是拒绝原因。
// realpath / stat 失败(不存在、无权限 …)同样是拒绝(fail-closed),由调用方决定报错退出还是跳过。
// uid 为 undefined(Windows 无 getuid)→ 不适用,路径原样。由 security-stdio-socket-owner.spec.ts 抽出本段直接测。
// <posix-socket-trust>
function resolveTrustedPosixSocket(socketPath, uid, fs) {
  if (uid === undefined) return { path: socketPath, error: null };
  let real;
  let leaf;
  let parent;
  try {
    real = fs.realpathSync(socketPath);
    leaf = fs.lstatSync(real);
    parent = fs.statSync(path.dirname(real));
  } catch (err) {
    return { path: socketPath, error: `cannot verify socket: ${err?.message ?? err}` };
  }
  let error = null;
  if (!leaf.isSocket()) error = 'not a socket';
  else if (leaf.uid !== uid) error = 'socket is not owned by the current user';
  else if (parent.uid !== uid || (parent.mode & 0o022) !== 0) {
    error = 'socket directory is not owned by the current user or is writable by others';
  }
  return { path: real, error };
}
// </posix-socket-trust>
function trustedSocket(socketPath) {
  // Windows 无 process.getuid → uid 为 undefined,resolveTrustedPosixSocket 原样返回路径。
  return resolveTrustedPosixSocket(socketPath, process.getuid?.(), { realpathSync, lstatSync, statSync });
}

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
  const envSocket = process.env.CONTINUO_MCP_SOCKET;
  if (envSocket) {
    if (!isAcceptableEnvSocket(envSocket, process.platform)) {
      process.stderr.write(
        `[continuo-mcp-stdio] CONTINUO_MCP_SOCKET is not a local Continuo pipe name: ${JSON.stringify(envSocket)}\n`,
      );
      process.exit(1);
    }
    // 不属于当前用户的 socket / 无法校验的路径:不连接(连上即便不发 hello,对方也能伪造工具结果),直接报错退出。
    const trusted = trustedSocket(envSocket);
    if (trusted.error) {
      process.stderr.write(
        `[continuo-mcp-stdio] refusing CONTINUO_MCP_SOCKET ${JSON.stringify(envSocket)}: ${trusted.error}\n`,
      );
      process.exit(1);
    }
    return [trusted.path];
  }
  if (process.platform === 'win32') return readWindowsPipeDiscovery(windowsAppDataDir());
  // existsSync 只用于筛掉明显不存在的路径(给清晰错误);存在 ≠ 有人在听,真正判定靠连接。
  // 通过校验的候选换成解析后的路径(连接的就是校验过的那个);不可信 / 无法校验 → 跳过。
  const candidates = [];
  for (const p of [packagedSocketPath(), devSocketPath()]) {
    if (!existsSync(p)) continue;
    const trusted = trustedSocket(p);
    if (trusted.error) process.stderr.write(`[continuo-mcp-stdio] skipping ${p}: ${trusted.error}\n`);
    else candidates.push(trusted.path);
  }
  return candidates;
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
      ? `[continuo-mcp-stdio] no valid pipe discovery file under ${windowsAppDataDir()}\\{continuo,Continuo Dev}\\mcp-pipe\n`
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
