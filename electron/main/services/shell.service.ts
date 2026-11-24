// Shell 一次性 exec(plugin app.shell.exec 后端)。
// 用 child_process.spawn 收 stdout/stderr 到 buffer,超时 SIGTERM,输出
// 上限 cap 避免 OOM。返回完整 IpcShellExecResult,plugin 等 process exit 后拿。

import { MAX_EXTERNAL_URL_LEN, startsWithAllowedExternalScheme } from '../../shared/url-limits';
import { startsWithAsciiIgnoreCase } from '../../shared/lower-if-needed';
import { spawn } from 'node:child_process';
import { shell } from 'electron';
import { codedError, errorMessage } from '../../shared/error-message';
import { ERROR_CODES } from '../../shared/error-codes';
import { SHELL_MAX_TIMEOUT_MS } from '../../shared/shell-limits';
import { TREE_KILL_DETACHED } from '../lib/kill-with-grace';
import {
  clampShellTimeoutMs,
  createPluginShellChildren,
  killTreeWithForceSettle,
} from '../lib/plugin-shell-children';
import {
  mergeSpawnEnv,
  stripInternalSecretEnv,
  resolveSpawnCommand,
  withGitHardeningEnv,
} from '../lib/child-spawn-hardening';
import { makeWcGoneHook } from '../lib/wc-gone-hook';
import type {
  IpcShellExecInput,
  IpcShellExecResult,
  IpcShellOpenExternalInput,
} from '../../shared/shell-channels';

const DEFAULT_TIMEOUT_MS = 30_000;
// 上界封顶:绑定子进程最长存活时间 / 单次 buffered 输出上限。孪生的流式版
// plugin-shell-stream 早已 `Math.min(opts.timeoutMs, MAX_TIMEOUT_MS)` 封顶到 30min,
// 而一次性 exec 此前只有 DEFAULT 没有 MAX —— 插件传 timeoutMs:2e9(~23 天,仍 < 2³¹
// 不触发 timer 截断)可把不退出的子进程 + stdout/stderr Buffer 钉到那个超时。补齐
// 同款上界,让两个兄弟入口的安全意图一致(防御未传播到平行入口)。
const MAX_TIMEOUT_MS = SHELL_MAX_TIMEOUT_MS; // 30min,与 plugin-shell-stream 同一来源
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_OUTPUT_BYTES_CAP = 100 * 1024 * 1024; // 100MB 硬上限,防超大值钉住内存
// 超时后 SIGTERM → SIGKILL 的宽限(流式 shell 用 killWithGrace 默认 1s;一次性 exec 历来更短,保留)。
const SIGKILL_GRACE_MS = 500;

// 边界(E248,E10/E122 clamp 非有限值族):helper 自身完整归一化,不依赖 IPC zod 前门。execShell 与这两个
// helper 都是导出 service 入口(单测/SDK 集成/未来内部调用直接用,绕过 schema)。非有限/≤0 回默认值,
// 有限正数再 Math.trunc(整数 ms/字节)+ 上限裁剪。timeout 规则与流式 shell 共用(lib/plugin-shell-children)。
/** timeoutMs 归一到 (0, MAX_TIMEOUT_MS];非有限/≤0/缺省走 DEFAULT。纯函数,便于测试 clamp。 */
export function clampExecTimeoutMs(input?: number): number {
  return clampShellTimeoutMs(input, DEFAULT_TIMEOUT_MS);
}

/** maxOutputBytes 归一到 (0, MAX_OUTPUT_BYTES_CAP];非有限/≤0/缺省走 DEFAULT。纯函数。 */
export function clampExecMaxBytes(input?: number): number {
  if (input === undefined || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_MAX_OUTPUT_BYTES;
  }
  return Math.min(Math.trunc(input), MAX_OUTPUT_BYTES_CAP);
}

export const EXEC_LIMITS_FOR_TEST = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES_CAP,
} as const;

// 终审 P1(E230 同族,数量上限):在途 exec 子进程并发上限。插件循环调用 exec 不 await → 此前无限 spawn,耗尽
// PID / FD。与 plugin-shell-stream 同款全局 + 单 sender 双闸(无 senderId 的内部调用只计全局),spawn 前
// fail-fast 拒绝(不 spawn、不起 timer)。名额在 close / error 时归还。
const MAX_ACTIVE_EXECS_GLOBAL = 128;
const MAX_ACTIVE_EXECS_PER_SENDER = 32;

export const MAX_ACTIVE_EXECS_GLOBAL_FOR_TEST = MAX_ACTIVE_EXECS_GLOBAL;
export const MAX_ACTIVE_EXECS_PER_SENDER_FOR_TEST = MAX_ACTIVE_EXECS_PER_SENDER;

// 在途登记 / 退出闸 / 退出清理 / 按 sender 与按插件终止,见 lib/plugin-shell-children。
const children = createPluginShellChildren({
  maxGlobal: MAX_ACTIVE_EXECS_GLOBAL,
  maxPerSender: MAX_ACTIVE_EXECS_PER_SENDER,
});

/** 测试用:复位退出闸(模块级状态)。 */
export function resetShellExecShutdownForTest(): void {
  children.resetShutdownForTest();
}

/** 退出清理(before-quit awaited):立即强杀所有在途 exec 的进程树并等待 close(有上限);此后 exec 一律拒绝。 */
export function cleanupAllShellExecs(): Promise<void> {
  return children.cleanupAll();
}

// 终审 P1:窗口关闭 / 整页重载后回收该 sender 的 exec(此前 detached 进程跑到超时并占着名额)。
// 与流式 shell 同一钩子(destroyed + main frame 非同文档导航),IPC 入口每次 exec 前挂(按 webContents 去重)。
export const attachShellExecWcGoneHook = makeWcGoneHook((senderId) => {
  void children.killForSender(senderId);
});

/**
 * 跑一个进程到 exit,buffered 输出 + 超时 + 大小上限.
 * @param senderId 发起请求的 webContents id(IPC 入口传入):与 input.pluginId 一起登记进程归属,
 *   插件停用/卸载时按 (窗口, 插件) 终止(终审 P1)。
 */
export function execShell(
  input: IpcShellExecInput,
  senderId?: number,
): Promise<IpcShellExecResult> {
  if (children.isShuttingDown()) {
    return Promise.reject(
      codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, 'shell exec rejected: app is quitting'),
    );
  }
  if (children.atCapacity(senderId)) {
    return Promise.reject(
      codedError(ERROR_CODES.TOO_MANY_STREAMS, 'too many active shell execs'),
    );
  }
  return new Promise((resolve) => {
    const timeoutMs = clampExecTimeoutMs(input.timeoutMs);
    const maxBytes = clampExecMaxBytes(input.maxOutputBytes);
    // 安全:注入 git 命令行作用域 core.fsmonitor=false,恶意 workspace 的 .git/config 不能借插件的
    // `git status` 执行任意命令(见 lib/child-spawn-hardening)。
    // Windows env 键大小写不敏感合并(插件 PATH 不与宿主 Path 并存),命令解析与子进程 env 一致。
    // 剥离宿主内部机密(CONTINUO_MCP_TOKEN,继承的或插件显式传入的),见 INTERNAL_SECRET_ENV_KEYS。
    const env = withGitHardeningEnv(
      stripInternalSecretEnv(input.env ? mergeSpawnEnv(process.env, input.env) : process.env),
    );

    let child;
    try {
      // 注:不用 `shell: true`。spawn 的契约是参数数组原子传递;Windows 上 shell:true
      // 会把 args[] 重新拼进 cmd.exe 命令行,含空格/`&`/`|`/`%` 的参数被拆分或当 shell
      // 语法执行 → 破坏参数原子性 + 命令注入面。Windows 下 `.cmd`/
      // `.bat`(npm/pnpm 等)无法直接 spawn 的正确解法是 PATHEXT 检测 + 仅对 .cmd/.bat
      // 走 `cmd.exe /d /s /c` 并对每个 arg 做 Windows quoting,需 Windows 实测 → DEFER。
      // 安全(Windows):裸命令名只在 PATH 绝对目录中解析,不查 cwd(workspace 根的 git.exe);解析不到抛错
      // 走下方 spawn failed(见 lib/child-spawn-hardening)。
      child = spawn(resolveSpawnCommand(input.cmd, env), [...input.args], {
        cwd: input.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 新进程组(POSIX),超时整组终止,后台后代不成孤儿持管道(见 processTreeKillable)。
        detached: TREE_KILL_DETACHED,
      });
    } catch (err) {
      // spawn 同步抛(cmd 不可执行等)
      resolve({
        stdout: '',
        stderr: `spawn failed: ${errorMessage(err)}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
      });
      return;
    }
    // close / error 时自动注销并归还名额;senderId + pluginId 登记归属,供按插件终止。
    children.track(child, senderId, input.pluginId);

    // 按**字节**累加并封顶,最后一次性解码 —— 旧实现用 `string.length`(UTF-16
    // code unit)当字节比较,且对每个 data chunk 单独 toString,多字节 UTF-8 序列
    // 被切到两个 chunk 时边界产生替换字符(乱码)。收集 Buffer 后 concat 再 decode
    // 消除跨 chunk 乱码;按 byteLength 封顶兑现 maxOutputBytes 的字节语义(审计 P2)。
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;

    const append = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const chunks = which === 'stdout' ? stdoutChunks : stderrChunks;
      const curBytes = which === 'stdout' ? stdoutBytes : stderrBytes;
      if (curBytes >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - curBytes;
      const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
      chunks.push(take);
      if (which === 'stdout') stdoutBytes += take.length;
      else stderrBytes += take.length;
      if (chunk.length > room) truncated = true;
    };

    const decode = (chunks: Buffer[]): string =>
      Buffer.concat(chunks).toString('utf-8');

    // 性能:某流写满 maxBytes 后摘掉其 JS data 处理,切为丢弃式 drain —— 否则 `yes` / 失控日志在截断后
    // 仍逐 chunk 进 JS 回调,main 热路径空转到超时。流保持 flowing(无 data listener 时 chunk 直接丢弃,
    // 不反压子进程,exit/close 照常)。恰好写满时尚不知是否还有后续输出:挂一次性 listener,再来数据才置
    // truncated(与旧实现「满后再收到 chunk 即 truncated」一致),之后无任何 listener。
    const markTruncated = (): void => {
      truncated = true;
    };
    const capped = (
      stream: NodeJS.ReadableStream | null,
      which: 'stdout' | 'stderr',
    ): void => {
      if (!stream) return;
      const onData = (c: Buffer): void => {
        append(which, c);
        if ((which === 'stdout' ? stdoutBytes : stderrBytes) < maxBytes) return;
        stream.removeListener('data', onData);
        if (!truncated) stream.once('data', markTruncated);
        stream.resume();
      };
      stream.on('data', onData);
    };
    capped(child.stdout, 'stdout');
    capped(child.stderr, 'stderr');

    // 一次性非交互 API:无论有无 input 都要 end stdin。旧实现只在有 input 时 end,
    // 无 input 时管道一直开着 → cat / python - 等读 stdin 的命令永远等不到 EOF,
    // 卡到超时被 SIGTERM。
    if (child.stdin) {
      // 子进程不读 stdin / 写入前就退出时,向已关闭的管道写会在 stdin 流上发
      // 'error'(EPIPE)。stdin 是独立 emitter,'error' 无监听者会上抛为
      // uncaughtException;electron/main 没有任何 uncaughtException 兜底 →
      // 一次 EPIPE 崩溃整个主进程(所有窗口 + 未保存状态全丢)。挂 'error'
      // 监听吞掉,并 try/catch 同步 write/end(进程已退出的边界)。
      child.stdin.on('error', () => {
        /* EPIPE / 管道已关闭:子进程不读 stdin,忽略,exit/close 会照常 resolve */
      });
      try {
        if (input.input !== undefined) child.stdin.write(input.input);
        child.stdin.end();
      } catch {
        /* 已关闭的 stdin 同步抛错:同样忽略,交给 close/error 收尾 */
      }
    }

    // 注:SIGKILL 升级不得以 `child.killed` 判定 —— 它在 `kill('SIGTERM')` 成功**发出信号**后即为 true
    // (Node 语义:killed = 信号已发送,非进程已退出),曾让 SIGKILL 分支永不执行(审计 P1)。
    // 超时后宽限期的整组 SIGKILL 不随结算取消:整组 SIGTERM 后直接子进程先退出 → close → settle,
    // 若此时清掉它,同组内忽略 SIGTERM 且不持管道的后代会存活成孤儿。故一经发起进程树终止,宽限期满
    // 无论直接子进程是否已退出都对整组 SIGKILL(组已不存在 ESRCH 由 processTreeKillable 吞掉)。
    // timer 仅在超时后才挂、最多 SIGKILL_GRACE_MS 且 unref,不阻止进程退出(P2-AP 的资源顾虑有界)。
    let cancelForceSettle: (() => void) | null = null;
    const clearTimers = (): void => {
      clearTimeout(timer);
      cancelForceSettle?.();
      cancelForceSettle = null;
    };
    // 超时终止整棵进程树(只杀直接子进程时后台后代持管道 → close 不来 → Promise 挂住);仍等不到 close
    // (后代逃出进程组仍持管道)→ 销毁 stdio 强制结算,不无限等待(lib/plugin-shell-children)。
    const timer = setTimeout(() => {
      timedOut = true;
      cancelForceSettle = killTreeWithForceSettle(child, SIGKILL_GRACE_MS, () =>
        settle(child.exitCode, child.signalCode),
      );
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimers();
      resolve({
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks) + `\nspawn error: ${err.message}`,
        exitCode: null,
        signal: null,
        timedOut,
        truncated,
      });
    });

    function settle(code: number | null, signal: NodeJS.Signals | null): void {
      clearTimers();
      resolve({
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        exitCode: code,
        signal: typeof signal === 'string' ? signal : null,
        timedOut,
        truncated,
      });
    }
    child.on('close', settle);
  });
}

// shell.openExternal 白名单 scheme:仅 http/https/mailto。其他 scheme
// (如 javascript:、custom://)拒绝,防止恶意 markdown 通过 [text](javascript:...)
// 在主机执行任意代码 / 触发 protocol handler。Electron 文档同款建议。
//
// scheme 白名单(不含 file:,安全 S6)见 shared/url-limits.startsWithAllowedExternalScheme(与 renderer 共用)。
/**
 * 是否允许把该 URL 交给系统打开。所有调用 `shell.openExternal` 的入口都必须先过
 * 这个白名单 —— 包括 `windowOpenHandler` 的 deny 分支(`target="_blank"` 锚点点击,
 * 如 marketplace 的不受信 `authorUrl` / 评论 `url`)。共享同一断言,避免某个入口
 * 漏接白名单成为协议处理器投放面。
 */
export function isAllowedExternalUrl(url: string): boolean {
  return startsWithAllowedExternalScheme(url) && !hasControlChar(url);
}

// 安全:shell.openExternal 交 GURL 解析时按 URL 规范删掉 Tab / CR / LF,下游客户端对其它控制字符的处理也不可知。
// 若放行,`mailto:x?att<TAB>ach=~/.ssh/id_rsa` 在 sanitizeExternalUrl 里键名是 `att\tach`(不删),交出后却成 attach。
// 正常外链(Markdown 链接目标 / 终端链接 / Chromium 已规范化的 window.open URL)不含 C0 控制字符与 DEL,
// 故所有 scheme 一律拒绝(fail-closed),不去猜下游的剥离规则。字符扫描,不走 RegExp(热路径约束同上)。
function hasControlChar(url: string): boolean {
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

// 安全 L4:mailto 的 attach / attachment 参数会让部分邮件客户端静默附加本地文件(Evolution CVE-2020-11879、
// KMail CVE-2020-11880)。openExternal 的输入含不受信 markdown / 终端输出链接,`mailto:x@evil?attach=~/.ssh/id_rsa`
// 经 xdg-open 交给邮件客户端即可外发私钥。统一出口净化(各平台都做)。
// **白名单**而非黑名单:只留 RFC 6068 常用头,其余一律丢弃。黑名单(attach / attachment)被绕过两次 ——
// `attach%00=`(键解码后带 NUL,不等于 attach,客户端却可能截断 / 忽略它)、`#&attach=`(见 sanitizeExternalUrl)。
// 已知残余:白名单参数的**值**里编码的分隔符不处理 —— `subject=x%26attach%3D/y` 原样保留,对「先把整条 URL 解码
// 再按 & 切分」的客户端(不合 RFC 6068)仍可注入 attach。不处理是因为 `subject=Q%26A` 这类写法完全合法,拒绝或
// 改写会破坏正常链接;地址段不存在这种合法用法,已在 isSafeMailtoAddress 拒绝。
const MAILTO_ALLOWED_PARAMS = new Set(['to', 'cc', 'bcc', 'subject', 'body', 'in-reply-to']);

/** 该 mailto 参数段(`key=value` 原文)是否保留。解码失败 / 解码后含控制字符 / 键不在白名单 → 丢弃(fail-closed)。 */
function isAllowedMailtoParam(part: string): boolean {
  const eq = part.indexOf('=');
  let key: string;
  let value: string;
  try {
    key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    value = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1));
  } catch {
    return false;
  }
  // 先查控制字符再 trim:trim 会把首尾的 Tab / LF 洗掉,`%0Asubject` 不该因此变成合法键
  if (hasControlChar(key)) return false;
  const name = key.trim().toLowerCase();
  if (!MAILTO_ALLOWED_PARAMS.has(name)) return false;
  // body 的换行(RFC 6068 规定写作 %0D%0A)与 Tab 是合法正文;其它头的值里出现 CR / LF 是头注入形态,丢弃
  return !hasControlChar(name === 'body' ? value.replace(/[\t\r\n]/g, '') : value);
}

/** mailto 地址段是否可原样保留:能解码,且解码后不含控制字符与参数 / fragment 分隔符。 */
function isSafeMailtoAddress(address: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(address);
  } catch {
    return false;
  }
  if (hasControlChar(decoded)) return false;
  return !decoded.includes('?') && !decoded.includes('&') && !decoded.includes('#');
}

/**
 * 交系统打开前的 URL 净化:mailto 只保留白名单参数并去掉 fragment;其它 URL 原样返回。
 * 没有被丢弃内容的 mailto URL 逐字节不变。
 */
export function sanitizeExternalUrl(url: string): string {
  if (!startsWithAsciiIgnoreCase(url, 'mailto:')) return url;
  // mailto 没有 fragment 语义(RFC 6068 要求 # 必须编码),而不识别 fragment 的邮件客户端会把
  // `?subject=x#&attach=/path` 里 # 之后的内容继续当参数 → # 及其后全部丢弃。
  const hashIdx = url.indexOf('#');
  let noHash = hashIdx < 0 ? url : url.slice(0, hashIdx);
  let q = noHash.indexOf('?');
  // 地址段(scheme 之后、? 之前)同样不可信:「先整体解码再切分」的客户端会把其中编码的 ? & # 当分隔符、
  // 把编码的 CR / LF 当头分隔。解码失败,或解码后含控制字符 / ? / & / # → 丢弃整个地址段(fail-closed)。
  const SCHEME_LEN = 'mailto:'.length;
  const address = noHash.slice(SCHEME_LEN, q < 0 ? undefined : q);
  if (!isSafeMailtoAddress(address)) {
    noHash = noHash.slice(0, SCHEME_LEN) + (q < 0 ? '' : noHash.slice(q));
    q = q < 0 ? -1 : SCHEME_LEN;
  }
  if (q < 0) return noHash;
  // 按 & 与 ; 切分(部分客户端把 ; 当分隔符);保留的参数保持原文、顺序与原分隔符,空段原样保留。
  const parts = noHash.slice(q + 1).split(/([&;])/); // [段, 分隔符, 段, 分隔符, ...]
  let out = '';
  let removed = false;
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i]!;
    if (part !== '' && !isAllowedMailtoParam(part)) {
      removed = true;
      continue;
    }
    out += out === '' ? part : (parts[i - 1] ?? '&') + part;
  }
  if (!removed) return noHash;
  return noHash.slice(0, q) + (out !== '' ? `?${out}` : '');
}

/**
 * 外链出口的唯一规则:长度上限(MAX_EXTERNAL_URL_LEN)→ scheme 白名单(isAllowedExternalUrl)→ sanitize 后交系统打开。
 * 不放行返回 false(不打开)。renderer 显式外链 IPC 与页面触发的「离开应用」(window.open 被拒 / 主框架导航被拦)共用
 * —— 此前两处各自组合这三步,安全出口新增规则时易只改一处。
 */
export async function openExternalIfAllowed(url: unknown): Promise<boolean> {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_EXTERNAL_URL_LEN) return false;
  if (!isAllowedExternalUrl(url)) return false;
  await shell.openExternal(sanitizeExternalUrl(url));
  return true;
}

export async function openExternalUrl(
  input: IpcShellOpenExternalInput,
): Promise<void> {
  const url = input.url;
  if (!(await openExternalIfAllowed(url))) {
    throw new Error(
      `[shell.openExternal] scheme not allowed: ${url.slice(0, 32)}...`,
    );
  }
}
