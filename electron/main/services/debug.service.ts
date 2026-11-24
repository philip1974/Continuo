import { execFile as execFileCb } from 'node:child_process';
import { asRecord } from '../../shared/as-record';
import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DapClient,
  type DapEventMessage,
  type DapJson,
  type DapRequestMessage,
  type DapResponseMessage,
} from './dap-client';
import { resolveDebugAdapterPath } from './debug-adapter-provision';
import * as debugSessions from './debug-sessions.service';
import { getWorkspaceRoot } from './window-workspace-roots.service';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  DEBUG_EVALUATE_RESULT_BYTES_MAX,
  DEBUG_STACK_LEVELS_DEFAULT,
  DEBUG_STRING_BYTES_DEFAULT,
  DEBUG_VARIABLE_COUNT_DEFAULT,
  DEBUG_VARIABLE_DEPTH_DEFAULT,
  isDebugLaunchEnvForbidden,
} from '../../shared/mcp-debug-schemas';
import {
  DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX,
  type DebugBreakpoint,
  type DebugViewEvent,
  type DebugViewSessionSnapshot,
} from '../../shared/debug-view-channels';
import { codedError, toError } from '../../shared/error-message';
import { runSerialPerKey } from './serialize-per-key';
import { lowerIfNeeded } from '../../shared/lower-if-needed';
import { processTreeKillable } from '../lib/kill-with-grace';
import { isSameOrInsidePath } from '../lib/path-inside';

const execFile = promisify(execFileCb);

export interface DebugDapClientLike {
  readonly serverPid?: number;
  /** adapter 子进程已退出(其 pid 可能已被复用,清理不再对它发信号)。 */
  readonly serverExited?: boolean;
  /** adapter 子进程退出时回调(已退出则尽快回调)。 */
  onServerExit?(listener: () => void): void;
  spawnServer(): Promise<this>;
  connectToServer(): Promise<this>;
  createChildSession(): DebugDapClientLike;
  setStartDebuggingHandler(
    handler: ((request: DapRequestMessage) => Promise<DapJson | undefined> | DapJson | undefined) | null,
  ): void;
  on(eventName: string, callback: (event: DapEventMessage) => void): () => void;
  waitForEvent(eventName: string, timeoutMs: number): Promise<DapEventMessage>;
  sendRequest(
    command: string,
    args: DapJson,
    timeoutMs: number,
  ): Promise<DapResponseMessage>;
  sendRequestNoWait(command: string, args: DapJson): void;
  dispose(): Promise<void>;
  /** 在途请求全部结算后再 dispose(回收已结束的 child:其在途请求的响应可能排在 terminated 之后)。 */
  disposeWhenIdle(): Promise<void>;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export interface ProcessGroupEntry {
  readonly pid: number;
  readonly pgid: number;
  readonly command: string;
}

export interface DebugProcessOps {
  readonly processInfo: (pid: number | undefined) => Promise<ProcessInfo | null>;
  readonly pidsInProcessGroup: (pgid: number) => Promise<readonly ProcessGroupEntry[]>;
  readonly terminateProcessGroup: (
    pgid: number,
    watchedPids: readonly number[],
  ) => Promise<readonly number[]>;
}

export interface DebugEventSink {
  emit(ownerWindowId: number, event: DebugViewEvent): void;
}

// 安全:debug.launch 的 program/cwd 来自 agent,必须锁在 owner window 的 workspace 内,
// 否则 agent 可让 js-debug 启动工作区外任意脚本。注入式以便单测(realpath 需真实 FS)。
export interface DebugWorkspaceGuard {
  getWorkspaceRoot(windowId: number): string | null;
  realpath(target: string): Promise<string>;
}

const DEFAULT_WORKSPACE_GUARD: DebugWorkspaceGuard = {
  getWorkspaceRoot,
  realpath: (target) => realpath(target),
};

export interface DebugServiceOptions {
  readonly adapterPath?: string;
  readonly requestTimeoutMs?: number;
  readonly createDapClient?: (options: { adapterPath: string }) => DebugDapClientLike;
  readonly processOps?: DebugProcessOps;
  readonly workspace?: DebugWorkspaceGuard;
  /** 被调试程序的 node 绝对路径(注入式以便单测;默认按 main 进程自身 PATH 解析并缓存)。 */
  readonly resolveNodeRuntime?: () => Promise<string>;
}

export interface LaunchSessionInput {
  readonly program: string;
  readonly cwd?: string;
  readonly args?: readonly string[];
  readonly env?: readonly { readonly name: string; readonly value: string }[];
  readonly stopOnEntry?: boolean;
  readonly name?: string;
}

export interface DebugCallerContext {
  readonly ownerWindowId: number;
  readonly controllerToken: string;
  /** 调用方连接的 abort signal(MCP ctx.signal):launch 期间断开 → 回收已建的 adapter / session。 */
  readonly signal?: AbortSignal;
}

/**
 * 在途 launch 被取消(调用方断开 / 身份被吊销 / 窗口关闭 / 应用退出):不留下绑定死 subject 或已销毁窗口的会话
 *(新连接过不了 capability 闸,无法清理)。
 */
function launchCancelledError(): Error {
  return codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, 'debug launch cancelled (caller disconnected, revoked, window closed or app quitting)');
}

/** 文案固定、不回显调用方传入的 session id(可任意长)。 */
function sessionNotFoundError(): Error {
  return codedError(ERROR_CODES.DEBUG_SESSION_NOT_FOUND, 'debug session not found');
}

/** 退出清理(cleanupAll)开始之后发起的 launch:与在途 launch 被退出取消同一错误码。 */
function launchRejectedQuittingError(): Error {
  return codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, 'debug launch rejected: app is quitting');
}

/**
 * cleanupAll(应用退出)等待在途 launch 结算的上限。正常 spawn + initialize 在 1s 内;adapter 卡住时不无限拖住
 * 退出(DapClient 自身 ready 超时 15s、DebugService 请求超时默认 20s,超出本上限的那次 launch 结算后仍会自行释放 adapter)。
 */
export const DEBUG_LAUNCH_SETTLE_WAIT_MS = 5_000;

/**
 * teardown 等待各连接应答 disconnect 的**总**上限。父连接与全部 child 并行发出 disconnect、共用这一上限:
 * 正常 adapter 毫秒级应答;失联时不再按连接数(无上限)叠加等待拖住退出,超时即进入进程组 / 进程树终止。
 */
export const DEBUG_TEARDOWN_DISCONNECT_TIMEOUT_MS = 2_000;

/**
 * 一次在途 debug.launch(会话尚未交给调用方)。launchSession 入口**同步**登记、结束时注销,所以吊销 / 关窗 / 退出
 * 取消「当时登记的在途 launch」就等于只取消在它之前启动的 launch(吊销代际语义):之后新发起的 launch 不受影响,
 * 不需要记永久的吊销表。
 */
interface InFlightLaunch {
  readonly ownerWindowId: number;
  readonly controllerToken: string;
  /** 取消本次 launch:aborted 即取消标志,launch 在各检查点退出并释放已 spawn 的 adapter / 已登记的会话。 */
  readonly abort: AbortController;
  /** spawn 前预占的名额:登记会话时由 add 消耗,失败 / 取消时在 launchSession 结束时释放。 */
  reservation?: debugSessions.CapacityReservation;
  /** launch 结算(成功或失败,不 reject):cleanupAll 据此等待。 */
  settled?: Promise<unknown>;
}

export interface SetBreakpointInput {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
}

export interface WaitForStopInput {
  readonly afterStopSeq?: number;
  readonly timeoutMs: number;
}

export interface WaitForStopOutput {
  readonly session_id: string;
  readonly stop_seq: number;
  readonly reason: string;
  readonly thread_id?: number;
  readonly description?: string;
}

// 形态定义在 shared(与 renderer 的 debug.store 共用),这里转出供 main 侧既有 import 使用。
export type { DebugScope, DebugStackFrame, DebugVariable } from '../../shared/debug-view-channels';
import type { DebugScope, DebugStackFrame, DebugVariable } from '../../shared/debug-view-channels';
import { sleep, waitAtMost } from '../lib/wait-at-most';
import { truncateUtf8, utf8ByteLength } from '../../shared/utf8-byte-length';

interface StopWaiter {
  readonly afterStopSeq: number;
  readonly resolve: (value: WaitForStopOutput) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface BreakpointReport {
  readonly line: number;
  readonly verified: boolean;
  readonly message?: string;
}

interface BreakpointRecord {
  /** source 分组键(sourceKey):同一 source 的不同拼写归为一组。 */
  readonly source: string;
  readonly line: number;
  readonly column?: number;
  /**
   * adapter 在各连接上对它的最近回报(校正后的行等),按连接分别记:js-debug 的绑定结果只在 child 上(child 的
   * 响应 / changed 事件 / 命中),父连接一直回 provisional / Unbound。对外状态由 aggregateReport 聚合。
   * adapter 对未变化的集合可能不逐项回报,缺项时沿用该连接上次的回报。
   */
  readonly reportedBy: Map<DebugDapClientLike, BreakpointReport>;
  /**
   * adapter 在各连接上给它分配的 id(js-debug 按连接各自编号、每次 setBreakpoints 重新编号),
   * 供 `breakpoint` 事件按「连接 + id」回找记录。
   */
  readonly ids: Map<DebugDapClientLike, number>;
}

interface RuntimeDebugSession {
  readonly id: string;
  /** adapter 退出那一刻对其进程组的处理(teardown 等它结束,之后不再凭旧 pgid 动手)。 */
  adapterExitReap?: Promise<void>;
  readonly parentClient: DebugDapClientLike;
  activeClient: DebugDapClientLike;
  readonly childClients: DebugDapClientLike[];
  /** program / cwd 是 workspace 闸校验后的真实路径(cwd 恒有值)。 */
  readonly launch: LaunchSessionInput & { readonly cwd: string };
  /** 被调试程序的 node 绝对路径(launch 时由 main 解析;父 / child 的 launch 都固定用它)。 */
  readonly runtimeExecutable: string;
  readonly waiters: Set<StopWaiter>;
  /** 全部已设断点(同 file+line 去重);setBreakpoints 按 file 取出该 source 的完整集合发送。 */
  readonly breakpoints: BreakpointRecord[];
  /** source 分组键 → 该 source 首次记录的调用方拼写(推给 renderer 用它,同一 source 恒定)。 */
  readonly sourcePaths: Map<string, string>;
  /**
   * source 分组键 → 发给 adapter 的拼写(realpath 后 normalize)。js-debug 按 Node 实际加载的真实路径匹配脚本,
   * 软链拼写(macOS /var → /private/var)的断点加载后回 Unbound;renderer 仍用 sourcePaths(编辑器 tab 路径
   * 来自用户选的 workspace root,未必是真实路径)。
   */
  readonly adapterPaths: Map<string, string>;
  /**
   * 调用方拼写的分组键 → 该拼写最近一次 realpath 成功时的分组键。目标文件之后被删、realpath 失败时沿用它,
   * 不按调用方拼写另起 fallback 组(否则只下发新那行,renderer 同显示路径的快照整组替换隐藏旧行)。
   */
  readonly resolvedSources: Map<string, string>;
  /**
   * 各连接上按 id 查不到记录的 breakpoint changed 事件(id → 最新的 breakpoint 体)。DapClient 在同一 chunk 里
   * 先 resolve setBreakpoints 响应、再同步分发紧随其后的事件,await 续体登记新 id 之前事件就到了;登记 id 后补上。
   * 有上限(超出丢最旧的)。
   */
  readonly pendingBreakpointChanges: Map<DebugDapClientLike, Map<number, Record<string, unknown>>>;
  /** 各连接 process 事件回报的 debuggee pid:该连接结束时据此移出 systemProcessIds。 */
  readonly processIdsByClient: Map<DebugDapClientLike, number[]>;
  configurationDone: boolean;
  launched: boolean;
  /** configurationDone + launch 的在途 / 已完成 Promise(并发的 wait_for_stop / continue 只起跑一次)。 */
  programStart?: Promise<void>;
  currentStop?: WaitForStopOutput;
  /** debuggee 已结束(terminated / exited)时的说明;置位后 wait_for_stop 立即以它 reject。 */
  endedMessage?: string;
  /**
   * 是否有 child 发过 terminated / exited。结束的 child 当即从 childClients 移除并 dispose(主线程长期存活、
   * 反复创建 worker 的程序不能让历史连接无界累积),childClients 只剩存活 / 握手中的连接。
   */
  childEnded: boolean;
  /** 当前呈现的停点发生在哪条连接上(currentStop 有值时才有意义)。 */
  stoppedClient?: DebugDapClientLike;
  /**
   * 当前停点尚未恢复时,别的连接上又发生的停点(主线程与 worker 各命中一个断点)。会话一次只呈现一个停点,
   * 其余在此排队;当前停点恢复后依次呈现 —— 否则后停的会把先停的顶掉,先停的那条连接再也没法被继续。
   */
  readonly queuedStops: Array<{ client: DebugDapClientLike; body: DapJson | undefined }>;
}


function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function boolField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function initializeArgs(): DapJson {
  return {
    adapterID: 'pwa-node',
    clientID: 'continuo-debug',
    clientName: 'Continuo debug',
    columnsStartAt1: true,
    linesStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsVariablePaging: true,
  };
}

function toEnvObject(
  env: readonly { readonly name: string; readonly value: string }[] | undefined,
): Record<string, string> | undefined {
  if (!env || env.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of env) out[entry.name] = entry.value;
  return out;
}

/**
 * 在 PATH(main 进程自身的,**不含** agent 传入的 launch env)中查找 node,返回 realpath 后的绝对路径。
 * 安全:launch 不指定 runtimeExecutable 时 js-debug 按 launch.env 的 PATH 找 `node` 并先执行 `node --version`,
 * agent 传 PATH=/tmp/payload 即可在工作区外执行任意代码。runtimeExecutable 固定为这里解析出的路径后,
 * env 里的 PATH 只影响被调试程序自身,不再影响用哪个 node。空项与相对路径项跳过(相对项按 cwd 解析,不可信)。
 */
export async function findNodeRuntimeOnPath(pathValue: string | undefined): Promise<string> {
  const exe = platform() === 'win32' ? 'node.exe' : 'node';
  for (const dir of (pathValue ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    try {
      const real = await realpath(path.join(dir, exe));
      if (!(await stat(real)).isFile()) continue;
      await access(real, fsConstants.X_OK);
      return real;
    } catch {
      // 该目录下没有可执行的 node:看下一项
    }
  }
  throw codedError(ERROR_CODES.DEBUG_NODE_RUNTIME_NOT_FOUND, `debug launch: ${exe} not found on Continuo's PATH`);
}

/** 执行用户登录 shell 并返回 stdout(注入点:单测不真的 spawn 用户 shell)。 */
export type LoginShellExec = (shell: string, args: readonly string[], timeoutMs: number) => Promise<string>;

/** 登录 shell 取 PATH 的耗时上限(rc 文件可能很慢;超时视为取不到)。 */
const LOGIN_SHELL_TIMEOUT_MS = 10_000;
/** 包裹 `$PATH` 输出的标记:rc 文件可能打印 banner 等,只取两个标记之间的内容。 */
const LOGIN_SHELL_PATH_MARKER = '__CONTINUO_LOGIN_PATH_b7e3f1__';

export const defaultExecLoginShell: LoginShellExec = async (shell, args, timeoutMs) => {
  // 安全:cwd 显式设为用户主目录,不继承主进程 cwd —— CLI 从不可信仓库目录启动时主进程 cwd 即该目录,
  // 用户 rc 里「启动即读 cwd」的片段(nvm load-nvmrc、direnv 等)会读到仓库里的文件。
  const { stdout } = await execFile(shell, [...args], {
    cwd: homedir(),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

/**
 * 用户登录 shell 的 PATH(参照 VSCode resolveShellEnv / fix-path):macOS 从 Finder 启动的应用只继承
 * /usr/bin:/bin:/usr/sbin:/sbin,Homebrew / nvm 的 node 不在其中。这仍是 Continuo 可信环境(用户自己的
 * 登录 shell 与 main 进程 env),与 agent 传入的 launch env 无关。取不到返回 undefined。
 */
async function readLoginShellPath(
  env: NodeJS.ProcessEnv,
  execLoginShell: LoginShellExec,
): Promise<string | undefined> {
  const shell = env.SHELL || (platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const marker = LOGIN_SHELL_PATH_MARKER;
  try {
    const stdout = await execLoginShell(
      shell,
      ['-ilc', `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`],
      LOGIN_SHELL_TIMEOUT_MS,
    );
    const start = stdout.indexOf(marker);
    const end = stdout.indexOf(marker, start + marker.length);
    if (start === -1 || end === -1) return undefined;
    return stdout.slice(start + marker.length, end);
  } catch {
    return undefined;
  }
}

/**
 * 被调试程序的 node 解析器:先查 main 进程自身 PATH;找不到时(非 Windows)执行一次用户登录 shell 取 PATH,
 * 按同样规则查找。只缓存成功;失败不缓存,用户装好 node 后可直接重试。登录 shell 有成本,只在首次且 main PATH
 * 找不到时执行。
 */
export function createNodeRuntimeResolver(deps: {
  readonly env: NodeJS.ProcessEnv;
  readonly execLoginShell: LoginShellExec;
}): () => Promise<string> {
  let cached: Promise<string> | null = null;
  const resolveOnce = async (): Promise<string> => {
    try {
      return await findNodeRuntimeOnPath(deps.env.PATH);
    } catch (err) {
      if (platform() === 'win32') throw err;
      const loginPath = await readLoginShellPath(deps.env, deps.execLoginShell);
      if (loginPath === undefined) throw err;
      return findNodeRuntimeOnPath(loginPath);
    }
  };
  return () => {
    cached ??= resolveOnce().catch((err: unknown) => {
      cached = null;
      throw err;
    });
    return cached;
  };
}

const defaultResolveNodeRuntime = createNodeRuntimeResolver({
  env: process.env,
  execLoginShell: defaultExecLoginShell,
});

/**
 * 安全闸:env 不得含让 Node / 动态链接器 / OpenSSL 加载额外代码的变量(规则见 isDebugLaunchEnvForbidden,
 * 大小写不敏感,Windows 的变量名大小写不敏感)。
 * 否则 NODE_OPTIONS=--require=/tmp/x.js 等在目标程序之前执行工作区外脚本,绕过 program / cwd 的工作区闸。
 */
function assertLaunchEnvAllowed(
  env: readonly { readonly name: string; readonly value: string }[] | undefined,
): void {
  for (const entry of env ?? []) {
    if (isDebugLaunchEnvForbidden(entry.name)) {
      throw codedError(
        ERROR_CODES.DEBUG_PROGRAM_OUTSIDE_WORKSPACE,
        `debug launch env must not set ${entry.name}: it loads code outside the workspace`,
      );
    }
  }
}

/**
 * source 的记录拼写:按平台 normalize(折叠 `..` / `.` / 重复分隔符;Windows 还把 `/` 统一成 `\`)。
 * 发给 adapter、推给 renderer 都用它;sourceKey 也在它之上分组,两者同一规则。
 */
function normalizeSourcePath(file: string): string {
  return platform() === 'win32' ? path.win32.normalize(file) : path.posix.normalize(file);
}

/**
 * source 分组键。同一真实文件的不同拼写(`C:\repo\a.js` / `c:/repo/a.js` / `C:\repo\sub\..\a.js`)
 * 必须归为一组,否则后一次整组替换会删掉前一个的断点:先 normalize(与记录拼写同一规则),Windows 再折叠大小写。
 */
function sourceKey(file: string): string {
  const normalized = normalizeSourcePath(file);
  return platform() === 'win32' ? lowerIfNeeded(normalized) : normalized;
}

/**
 * 文件尚不存在时 realpath 失败,断点按调用方拼写分组(fallback 组);文件创建后同拼写 realpath 成功按真实路径
 * 分组。两组推给 renderer 的 file 相同,不合并的话后一次只下发自己那组,renderer 整组替换隐藏前一组。
 * 把 fallback 组并入真实路径组(同一行以真实路径组的为准,与「同 file+line 去重」一致),映射随之迁移。
 */
function mergeFallbackSource(
  runtime: RuntimeDebugSession,
  fallback: string,
  source: string,
): void {
  if (fallback === source) return;
  const lines = new Set(runtime.breakpoints.filter((bp) => bp.source === source).map((bp) => bp.line));
  for (let i = runtime.breakpoints.length - 1; i >= 0; i -= 1) {
    const bp = runtime.breakpoints[i]!;
    if (bp.source !== fallback) continue;
    if (lines.has(bp.line)) runtime.breakpoints.splice(i, 1);
    else runtime.breakpoints[i] = { ...bp, source };
  }
  const sourcePath = runtime.sourcePaths.get(fallback);
  if (sourcePath !== undefined && !runtime.sourcePaths.has(source)) {
    runtime.sourcePaths.set(source, sourcePath);
  }
  runtime.sourcePaths.delete(fallback);
  runtime.adapterPaths.delete(fallback);
}

/** 每条连接暂存的未匹配 breakpoint changed 事件上限(超出丢最旧的)。 */
const MAX_PENDING_BREAKPOINT_CHANGES = 64;

/** 向已建立的 child session 同步断点时的超时(child 同步是尽力而为:不应答的 child 只是不贡献回报)。 */
const CHILD_BREAKPOINT_SYNC_TIMEOUT_MS = 3_000;

/**
 * 一个 source 的 DAP setBreakpoints 参数(父 session 设置与子 session 重放共用)。DAP 语义:请求里的
 * breakpoints 是**该 source 的完整断点集合**,adapter 会清掉不在其中的旧断点 —— 所以必须带上该文件的全部断点。
 */
function setBreakpointsArgs(file: string, records: readonly BreakpointRecord[]): DapJson {
  return {
    source: { path: file },
    breakpoints: records.map((bp) => ({
      line: bp.line,
      ...(bp.column !== undefined ? { column: bp.column } : {}),
    })),
    sourceModified: false,
  };
}

/** breakpoint changed 事件体(DAP Breakpoint)写入该连接的回报;缺字段沿用该连接上次的回报。 */
function applyBreakpointChange(
  record: BreakpointRecord,
  client: DebugDapClientLike,
  breakpoint: Record<string, unknown>,
): void {
  const message = stringField(breakpoint, 'message');
  const last = record.reportedBy.get(client);
  record.reportedBy.set(client, {
    line: numberField(breakpoint, 'line') ?? last?.line ?? record.line,
    verified: boolField(breakpoint, 'verified') ?? last?.verified ?? true,
    ...(message !== undefined ? { message } : {}),
  });
}

/**
 * 记下 setBreakpoints 响应各项在该连接上的 id 与回报(响应与请求的 records 逐一对应;缺项保留该连接上次的
 * 回报,无 id 保留旧 id)。登记 id 后补上该连接上先到的同 id changed 事件(见 pendingBreakpointChanges)。
 */
function rememberBreakpointReports(
  runtime: RuntimeDebugSession,
  client: DebugDapClientLike,
  records: readonly BreakpointRecord[],
  response: DapResponseMessage,
): void {
  const pending = runtime.pendingBreakpointChanges.get(client);
  asArray(asRecord(response.body).breakpoints).forEach((item, i) => {
    const record = records[i];
    if (!record) return;
    const reported = asRecord(item as DapJson);
    const id = numberField(reported, 'id');
    if (id !== undefined) record.ids.set(client, id);
    const message = stringField(reported, 'message');
    record.reportedBy.set(client, {
      line: numberField(reported, 'line') ?? record.line,
      verified: boolField(reported, 'verified') ?? true,
      ...(message !== undefined ? { message } : {}),
    });
    const early = id !== undefined ? pending?.get(id) : undefined;
    if (early && id !== undefined) {
      pending?.delete(id);
      applyBreakpointChange(record, client, early);
    }
  });
}

/**
 * 断点对外的状态:任一存活连接 verified 即 verified(child 优先,取首个 —— 代码实际跑在 child 上),
 * 行取那条连接的校正行;都未 verified 时取父连接的回报,父连接没有则取首个存活 child 的。
 * 已结束的 child(及握手失败被摘除的)不参与。
 */
function aggregateReport(
  runtime: RuntimeDebugSession,
  record: BreakpointRecord,
): BreakpointReport | undefined {
  const reports = [...runtime.childClients, runtime.parentClient].flatMap((client) => {
    const report = record.reportedBy.get(client);
    return report ? [report] : [];
  });
  return (
    reports.find((report) => report.verified) ??
    record.reportedBy.get(runtime.parentClient) ??
    reports[0]
  );
}

/** 清掉各断点记录与暂存事件里该连接的条目(child 结束 / 握手失败被回收时,不再留着对它的引用)。 */
function forgetClient(runtime: RuntimeDebugSession, client: DebugDapClientLike): void {
  for (const bp of runtime.breakpoints) {
    bp.reportedBy.delete(client);
    bp.ids.delete(client);
  }
  runtime.pendingBreakpointChanges.delete(client);
}

/** 按 source 分组(保持首次出现顺序),供 child session 逐 source 重放。 */
function breakpointsBySource(
  records: readonly BreakpointRecord[],
): ReadonlyMap<string, readonly BreakpointRecord[]> {
  const out = new Map<string, BreakpointRecord[]>();
  for (const record of records) {
    const list = out.get(record.source);
    if (list) list.push(record);
    else out.set(record.source, [record]);
  }
  return out;
}

function makeSessionId(): string {
  return `debug-${crypto.randomUUID()}`;
}


/**
 * 一次 debug.variables 深度展开的总节点预算。每层逐个成员递归请求,count=100、max_depth=5 时最坏 100^5 级
 * 请求 / 节点,把主进程与 adapter 一起拖垮;2000 个节点足够 agent 看清一个停点的局部结构,更深的按
 * variables_reference 单独再取。
 */
export const DEBUG_VARIABLES_EXPAND_MAX_NODES = 2_000;

/** 一次 debug.variables 深度展开的总 DAP 请求预算(count 很小时节点预算管不住请求数)。 */
export const DEBUG_VARIABLES_EXPAND_MAX_REQUESTS = 200;

/**
 * 一次 debug.variables 返回内容的总字节预算(名称 + 值 + 类型的 UTF-8 字节,近似)。节点 / 请求预算管不住字节:
 * 2000 节点 × 64KiB 字符串 ≈ 124MB 驻留主进程,而 MCP 结果 10MiB 上限(RESULT_BYTES_MAX)要等展开完成序列化后
 * 才检查。取 4MiB:远低于 10MiB,给 JSON 转义 / 字段名 / 嵌套结构留足余量,结果不会因超限整个被拒。
 */
export const DEBUG_VARIABLES_EXPAND_MAX_BYTES = 4 * 1024 * 1024;

interface VariablesBudget {
  nodes: number;
  requests: number;
  /** 剩余可返回的内容字节(见 DEBUG_VARIABLES_EXPAND_MAX_BYTES)。 */
  bytes: number;
  /** 有节点因预算未展开。 */
  exhausted: boolean;
  readonly signal?: AbortSignal;
}

/** 调用方在 debug.variables 展开期间断开:结果已无人接收,停止继续请求。 */
function variablesCancelledError(): Error {
  return codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, 'caller disconnected during debug variables');
}

async function defaultProcessInfo(pid: number | undefined): Promise<ProcessInfo | null> {
  if (!pid || platform() === 'win32') return null;
  try {
    const { stdout } = await execFile('ps', [
      '-o',
      'pid=,ppid=,pgid=,command=',
      '-p',
      String(pid),
    ]);
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(stdout.trim());
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4] ?? '',
    };
  } catch {
    return null;
  }
}

async function defaultPidsInProcessGroup(
  pgid: number,
): Promise<readonly ProcessGroupEntry[]> {
  if (!pgid || platform() === 'win32') return [];
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,pgid=,command=']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match
          ? {
              pid: Number(match[1]),
              pgid: Number(match[2]),
              command: match[3] ?? '',
            }
          : null;
      })
      .filter((entry): entry is ProcessGroupEntry => entry !== null)
      .filter((entry) => entry.pgid === pgid);
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(
  pids: readonly number[],
  timeoutMs: number,
): Promise<readonly number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter(pidAlive);
    if (alive.length === 0) return [];
    await sleep(100);
  }
  return pids.filter(pidAlive);
}

async function defaultTerminateProcessGroup(
  pgid: number,
  watchedPids: readonly number[],
): Promise<readonly number[]> {
  if (!pgid) return [];
  if (platform() === 'win32') {
    // Windows 没有进程组可枚举:对 adapter 与已记录的 debuggee pid 各做 taskkill /T /F 整树强杀
    //(复用 kill-with-grace),未记录的后代随树一起回收。仍存活的再直杀兜底。watchedPids 不含已知结束的
    // 进程(调用方已剔除已退出的 adapter 与已结束的 debuggee):整树强杀复用了其 pid 的无关进程代价太大。
    const trees = watchedPids.map((pid) =>
      processTreeKillable({
        pid,
        kill: (signal) => {
          try {
            process.kill(pid, signal);
            return true;
          } catch {
            return false; // 已退出
          }
        },
      }),
    );
    for (const tree of trees) tree.kill('SIGTERM');
    let alive = await waitForDead(watchedPids, 1_500);
    if (alive.length > 0) {
      for (const pid of alive) trees[watchedPids.indexOf(pid)]?.kill('SIGKILL');
      alive = await waitForDead(alive, 3_000);
    }
    return alive;
  }

  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // group may already be gone after DAP disconnect
  }
  let alive = await waitForDead(watchedPids, 1_500);
  if (alive.length > 0) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // group may already be gone after SIGTERM
    }
    alive = await waitForDead(alive, 3_000);
  }
  return alive;
}

const DEFAULT_PROCESS_OPS: DebugProcessOps = {
  processInfo: defaultProcessInfo,
  pidsInProcessGroup: defaultPidsInProcessGroup,
  terminateProcessGroup: defaultTerminateProcessGroup,
};

export class DebugService {
  private adapterPath: string | null;
  private readonly requestTimeoutMs: number;
  private readonly createDapClient: (options: { adapterPath: string }) => DebugDapClientLike;
  private readonly processOps: DebugProcessOps;
  private readonly workspace: DebugWorkspaceGuard;
  private readonly resolveNodeRuntime: () => Promise<string>;
  private readonly runtimes = new Map<string, RuntimeDebugSession>();
  private readonly teardownInFlight = new Map<string, Promise<void>>();
  /** 按 session 串行 setBreakpoints(读集合→下发→回滚/推快照整段不交错)。 */
  private readonly breakpointChains = new Map<string, Promise<unknown>>();
  /**
   * 在途 launch 登记表。killByController / killByOwner / cleanupAll 只查得到已登记会话,据此取消尚未登记的;
   * 撤销授权按 listControllerTokens 枚举调用方,也须含这里的。
   */
  private readonly launches = new Set<InFlightLaunch>();
  /** cleanupAll(应用退出)已开始:此后 launch 一律拒绝 —— 只取消当时在途的 launch 时,之后新发起的照常 spawn。 */
  private shuttingDown = false;
  private eventSink: DebugEventSink | null = null;

  constructor(options: DebugServiceOptions = {}) {
    this.adapterPath =
      options.adapterPath ??
      (options.createDapClient ? '__injected-debug-adapter__' : null);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.createDapClient =
      options.createDapClient ??
      ((clientOptions) => new DapClient({ adapterPath: clientOptions.adapterPath }));
    this.processOps = options.processOps ?? DEFAULT_PROCESS_OPS;
    this.workspace = options.workspace ?? DEFAULT_WORKSPACE_GUARD;
    this.resolveNodeRuntime = options.resolveNodeRuntime ?? defaultResolveNodeRuntime;
  }

  // 安全闸:program/cwd 必须落在 owner window 的 workspace 内(realpath 后比较,防
  // symlink 逃逸与 `..` 穿越)。无 workspace 记录 → fail-closed 拒绝。
  // 返回校验通过的真实路径:起跑推迟到 wait_for_stop / continue,launch 必须用它们 —— 若沿用原拼写,
  // 校验后把工作区内软链改指工作区外即可绕过本闸(TOCTOU)。
  private async assertLaunchInsideWorkspace(
    ownerWindowId: number,
    program: string,
    cwd: string,
  ): Promise<{ program: string; cwd: string }> {
    const root = this.workspace.getWorkspaceRoot(ownerWindowId);
    if (root === null || root === '') {
      throw codedError(ERROR_CODES.DEBUG_PROGRAM_OUTSIDE_WORKSPACE, 'debug launch requires a workspace root for this window');
    }
    let realRoot: string;
    try {
      realRoot = await this.workspace.realpath(root);
    } catch {
      realRoot = root;
    }
    return {
      program: await this.assertPathInside(realRoot, program, 'program'),
      cwd: await this.assertPathInside(realRoot, cwd, 'cwd'),
    };
  }

  private async assertPathInside(
    realRoot: string,
    target: string,
    label: 'program' | 'cwd',
  ): Promise<string> {
    let realTarget: string;
    try {
      realTarget = await this.workspace.realpath(target);
    } catch {
      throw codedError(ERROR_CODES.DEBUG_PROGRAM_OUTSIDE_WORKSPACE, `debug ${label} not found or inaccessible: ${target}`);
    }
    if (!isSameOrInsidePath(realRoot, realTarget)) {
      throw codedError(ERROR_CODES.DEBUG_PROGRAM_OUTSIDE_WORKSPACE, `debug ${label} must be inside the workspace: ${target}`);
    }
    return realTarget;
  }

  setEventSink(eventSink: DebugEventSink | null): void {
    this.eventSink = eventSink;
  }

  async launchSession(
    input: LaunchSessionInput,
    ctx: DebugCallerContext,
  ): Promise<{ session_id: string; state: 'starting' | 'running' | 'stopped' }> {
    if (this.shuttingDown) throw launchRejectedQuittingError();
    // 必须在第一个 await 之前登记(见 InFlightLaunch)。调用方断开并入同一个取消信号。
    const launch: InFlightLaunch = {
      ownerWindowId: ctx.ownerWindowId,
      controllerToken: ctx.controllerToken,
      abort: new AbortController(),
    };
    const onCallerAbort = (): void => launch.abort.abort();
    if (ctx.signal?.aborted) launch.abort.abort();
    else ctx.signal?.addEventListener('abort', onCallerAbort, { once: true });
    this.launches.add(launch);
    const task = this.launchSessionInner(input, ctx, launch);
    launch.settled = task.catch(() => undefined);
    try {
      return await task;
    } finally {
      ctx.signal?.removeEventListener('abort', onCallerAbort);
      launch.reservation?.release();
      this.launches.delete(launch);
    }
  }

  /** 取消符合条件的在途 launch,返回它们的结算 promise。 */
  private cancelLaunches(match: (launch: InFlightLaunch) => boolean): Promise<unknown>[] {
    const settled: Promise<unknown>[] = [];
    for (const launch of this.launches) {
      if (!match(launch)) continue;
      launch.abort.abort();
      if (launch.settled) settled.push(launch.settled);
    }
    return settled;
  }

  private async launchSessionInner(
    input: LaunchSessionInput,
    ctx: DebugCallerContext,
    launch: InFlightLaunch,
  ): Promise<{ session_id: string; state: 'starting' | 'running' | 'stopped' }> {
    const cancelled = launch.abort.signal;
    // 安全闸:先验 env 与 program/cwd 落在 workspace 内,再花成本 spawn adapter。
    // cwd 省略时默认 workspace root(不再回退 main 进程 cwd)。
    assertLaunchEnvAllowed(input.env);
    const root = this.workspace.getWorkspaceRoot(ctx.ownerWindowId);
    const effectiveCwd = input.cwd ?? root ?? process.cwd();
    const verified = await this.assertLaunchInsideWorkspace(
      ctx.ownerWindowId,
      input.program,
      effectiveCwd,
    );
    // 被调试程序用哪个 node 由 main 解析(不受 env 影响);解析不到就拒绝,不 spawn adapter。
    const runtimeExecutable = await this.resolveNodeRuntime();
    // launch 固定用校验时的真实路径(见 assertLaunchInsideWorkspace);会话记录(debug-sessions)不保存 program / cwd。
    const normalizedInput = { ...input, program: verified.program, cwd: verified.cwd };
    // 名额被自然结束(terminated)的会话占满时回收最旧的:它们的 adapter 不会自己退出,否则一直占着名额。
    for (
      let victim = debugSessions.oldestTerminatedForCapacity(ctx.ownerWindowId);
      victim !== undefined;
      victim = debugSessions.oldestTerminatedForCapacity(ctx.ownerWindowId)
    ) {
      await this.teardownSession(victim.id, 'reclaim-terminated').catch(() => undefined);
    }
    // workspace 校验是异步边界,期间可能已被取消 → spawn 前复查。
    if (cancelled.aborted) throw launchCancelledError();
    // spawn 前同步预占名额(与上面回收后的检查之间无 await):满了就别 spawn adapter;并发 launch 各占一份,
    // 同时 spawn 中的 adapter 不超过上限。
    launch.reservation = debugSessions.reserve(ctx.ownerWindowId);

    const id = makeSessionId();
    const parentClient = this.createDapClient({
      adapterPath: this.resolveAdapterPathLazy(),
    });

    try {
      await parentClient.spawnServer();
    } catch (err) {
      // 此时还没登记 runtime / session,cleanupAll、killByOwner 都找不到这个 client;不在这里释放,
      // detached 的 adapter 进程和 socket 文件就成了孤儿(app 退出也不回收)。
      await parentClient.dispose().catch(() => undefined);
      throw err;
    }
    const adapterPid = parentClient.serverPid;
    const adapterInfo = await this.processOps.processInfo(adapterPid);
    // spawn 期间被取消(断开 / 吊销 / 关窗 / 退出):还没登记,teardown 查不到,就地释放 adapter。
    if (cancelled.aborted) {
      await parentClient.dispose().catch(() => undefined);
      throw launchCancelledError();
    }
    const runtime: RuntimeDebugSession = {
      id,
      parentClient,
      activeClient: parentClient,
      childClients: [],
      launch: normalizedInput,
      runtimeExecutable,
      waiters: new Set(),
      childEnded: false,
      queuedStops: [],
      breakpoints: [],
      sourcePaths: new Map(),
      adapterPaths: new Map(),
      resolvedSources: new Map(),
      pendingBreakpointChanges: new Map(),
      processIdsByClient: new Map(),
      configurationDone: false,
      launched: false,
    };
    try {
      debugSessions.add({
        id,
        ownerWindowId: ctx.ownerWindowId,
        controllerToken: ctx.controllerToken,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(adapterPid !== undefined ? { adapterPid } : {}),
      }, launch.reservation);
    } catch (err) {
      // 登记失败:session 没登记上,teardown 找不到它 → 就地释放 adapter。
      await parentClient.dispose().catch(() => undefined);
      throw err;
    }
    this.runtimes.set(id, runtime);
    if (adapterInfo) debugSessions.update(id, { adapterPgid: adapterInfo.pgid });
    parentClient.onServerExit?.(() => {
      runtime.adapterExitReap = this.reapAdapterGroupOnExit(id);
    });
    this.wireClient(id, parentClient);
    parentClient.setStartDebuggingHandler((request) =>
      this.handleStartDebugging(id, request, parentClient),
    );

    // initialize 期间被取消 → 立即拆除(不等 adapter 应答 / 请求超时才放出名额)。
    const onAbort = (): void => {
      void this.teardownSession(id, 'caller-disconnected').catch(() => undefined);
    };
    cancelled.addEventListener('abort', onAbort, { once: true });
    try {
      await this.initializeClient(parentClient);
    } catch (err) {
      // session 已登记、adapter 活着,但调用方只会拿到错误、拿不到 session_id → 自己拆掉。
      await this.teardownSession(id, 'launch-failed').catch(() => undefined);
      throw cancelled.aborted ? launchCancelledError() : err;
    } finally {
      cancelled.removeEventListener('abort', onAbort);
    }
    // initialize 期间被取消:会话已被拆(或正在拆),这里不能再把 session_id 交给调用方。
    if (cancelled.aborted) {
      await this.teardownSession(id, 'caller-disconnected').catch(() => undefined);
      throw launchCancelledError();
    }
    // 程序此时还没起跑(configurationDone + launch 推迟到第一个「要求程序运行」的调用,见 ensureProgramStarted),
    // 如实报 starting。
    return { session_id: id, state: 'starting' };
  }

  private resolveAdapterPathLazy(): string {
    if (this.adapterPath === null) {
      this.adapterPath = resolveDebugAdapterPath();
    }
    return this.adapterPath;
  }

  async setBreakpoints(
    sessionId: string,
    input: SetBreakpointInput,
  ): Promise<{ verified: boolean; line?: number; message?: string }> {
    this.requireRuntime(sessionId);
    // 同 session 串行:并发时 B 捕获的完整集合会含在途的 A,A 失败回滚时 B 已把 A 设进 adapter;
    // 成功响应乱序时旧快照事件还会覆盖新断点。串行化后集合与快照天然有序。
    // 按 session 而非 session+source:分组键依赖 realpath,入队前不能有 await —— 否则同一真实文件经不同拼写
    // 并发设置时,realpath 慢的旧调用在新调用之后入队,旧定义覆盖新定义。同 session 的断点设置很少并发,代价可忽略。
    return runSerialPerKey(this.breakpointChains, sessionId, () =>
      this.setBreakpointsSerial(sessionId, input),
    );
  }

  private async setBreakpointsSerial(
    sessionId: string,
    input: SetBreakpointInput,
  ): Promise<{ verified: boolean; line?: number; message?: string }> {
    // js-debug 按 Node 实际加载的真实路径匹配脚本:发给 adapter 的 path 与分组键基于 realpath(软链拼写与真实
    // 拼写归为同一 source)。文件不存在 / realpath 失败时沿用原路径,不报错。
    let realFile = input.file;
    let resolved = false;
    try {
      realFile = await this.workspace.realpath(input.file);
      resolved = true;
    } catch {
      // 沿用原路径。
    }
    // 排队 / realpath 期间 session 可能已拆除。
    const runtime = this.requireRuntime(sessionId);
    // 追加到该 source 的断点集合(同 file+line 替换,不重复);此前整表替换成 [input],同文件第二个断点
    // 会把第一个从 adapter 里删掉。
    const spellingKey = sourceKey(input.file);
    // realpath 失败但该拼写此前解析过:沿用已关联的真实路径组(文件被删后再设断点)。
    const source = resolved
      ? sourceKey(realFile)
      : (runtime.resolvedSources.get(spellingKey) ?? spellingKey);
    if (resolved) {
      mergeFallbackSource(runtime, spellingKey, source);
      runtime.resolvedSources.set(spellingKey, source);
    }
    // 记录的拼写 normalize(Windows 统一成反斜杠):编辑器 tab 路径来自原生对话框 / listDir(反斜杠、无 `..`),
    // renderer 按路径匹配 tab 放红点;首次以 `C:/repo/a.js` 设断点时沿用原拼写会匹配不上,gutter 不显示。
    if (!runtime.sourcePaths.has(source)) {
      runtime.sourcePaths.set(source, normalizeSourcePath(input.file));
    }
    if (!runtime.adapterPaths.has(source)) {
      runtime.adapterPaths.set(source, normalizeSourcePath(realFile));
    }
    const adapterPath = runtime.adapterPaths.get(source) ?? realFile;
    const existing = runtime.breakpoints.findIndex(
      (bp) => bp.source === source && bp.line === input.line,
    );
    const previous = existing >= 0 ? runtime.breakpoints[existing] : undefined;
    // 只有完全相同的重设才继承旧记录在各连接上的回报 / id;同一行改了 column 是新的断点定义,继承的话某条
    // 连接同步失败(被 allSettled 吞掉)时聚合仍用旧定义在它上面的 verified。
    const inherited = previous?.column === input.column ? previous : undefined;
    const record: BreakpointRecord = {
      source,
      line: input.line,
      ...(input.column !== undefined ? { column: input.column } : {}),
      reportedBy: new Map(inherited?.reportedBy),
      ids: new Map(inherited?.ids),
    };
    if (existing >= 0) runtime.breakpoints[existing] = record;
    else runtime.breakpoints.push(record);
    const sourceBreakpoints = runtime.breakpoints.filter((bp) => bp.source === source);
    const args = setBreakpointsArgs(adapterPath, sourceBreakpoints);
    let response: DapResponseMessage;
    try {
      response = await runtime.parentClient.sendRequest(
        'setBreakpoints',
        args,
        this.requestTimeoutMs,
      );
    } catch (err) {
      // adapter 拒绝 / 超时:调用方拿到失败,本次记录不得留在集合里 —— 否则之后同文件再设断点(发完整
      // 集合)或 child 建立时重放会悄悄下发它。按对象身份回滚(等待期间别的调用可能增删了其它记录)。
      const index = runtime.breakpoints.indexOf(record);
      if (index >= 0) {
        if (previous) runtime.breakpoints[index] = previous;
        else runtime.breakpoints.splice(index, 1);
      }
      // 超时不代表 adapter 没应用(可能只是响应迟到):尽力把回滚后的完整集合补发给父连接与存活的 child,
      // 短超时、失败忽略,原错误照常抛给调用方。
      const rolledBackRecords = runtime.breakpoints.filter((bp) => bp.source === source);
      const rolledBack = setBreakpointsArgs(adapterPath, rolledBackRecords);
      const liveClients = [runtime.parentClient, ...runtime.childClients];
      await Promise.allSettled(
        liveClients.map((client) =>
          this.sendBreakpointsTo(runtime, client, rolledBack, rolledBackRecords, CHILD_BREAKPOINT_SYNC_TIMEOUT_MS),
        ),
      );
      throw err;
    }
    rememberBreakpointReports(runtime, runtime.parentClient, sourceBreakpoints, response);
    // 已建立的 child session 各自维护断点:只发给父连接的话,程序跑起来之后再设的断点不会生效
    //(child 只在创建时拿到当时的断点)。逐个同步;某个 child 已退出导致失败不影响其它。
    // 取快照(发送期间 childClients 可能增减;已结束的 child 已从中移除)、并行发送并用较短的超时:某个 child
    // 不应答(已退出的 worker 等)不能把整个工具调用拖到 N × requestTimeoutMs。
    await Promise.allSettled(
      runtime.childClients.map((child) =>
        this.sendBreakpointsTo(runtime, child, args, sourceBreakpoints, CHILD_BREAKPOINT_SYNC_TIMEOUT_MS),
      ),
    );
    // 设断点本身不让程序起跑:起跑推迟到 wait_for_stop / continue / step(ensureProgramStarted),
    // 这样起跑前连设的多个断点都能在程序运行之前就位。
    // 返回值与快照同源(按连接聚合):父连接回 pending / Unbound 而 child 已绑定时报 verified;adapter 未回报
    // 本次那项时沿用各连接上次的回报,都没有才报 {verified:true}。
    this.emitBreakpointSnapshot(sessionId, runtime, source);
    return { ...(aggregateReport(runtime, record) ?? { verified: true }) };
  }

  /**
   * 推该 source 的完整集合(adapter 校正后的行号),renderer 整组替换:只推本次那一个时,同一逻辑
   * 断点被再次校正到别的行会留下旧红点。多个请求被校正到同一行时按校正后的 file:line 去重(保留首个),
   * 否则面板 key 重复、编辑器重复装饰 —— 去重只在这里做(单一来源;setBreakpoints 响应与 breakpoint 事件共用)。
   */
  private emitBreakpointSnapshot(
    sessionId: string,
    runtime: RuntimeDebugSession,
    source: string,
  ): void {
    const { file, breakpoints } = this.breakpointSnapshot(runtime, source);
    this.emitSessionEvent(sessionId, {
      type: 'breakpoints-changed',
      sessionId,
      file,
      breakpoints,
    });
  }

  /** 该 source 的完整断点集合(推送给 renderer 的形态);事件与 subscribe 快照共用。 */
  private breakpointSnapshot(
    runtime: RuntimeDebugSession,
    source: string,
  ): { file: string; breakpoints: DebugBreakpoint[] } {
    const sourcePath = runtime.sourcePaths.get(source) ?? source;
    const seenLines = new Set<number>();
    const snapshot = runtime.breakpoints
      .filter((bp) => bp.source === source)
      .flatMap((bp) => {
        const { line, verified, message } = aggregateReport(runtime, bp) ?? {
          line: bp.line,
          verified: true,
        };
        if (seenLines.has(line)) return [];
        seenLines.add(line);
        return [
          {
            file: sourcePath,
            line,
            ...(bp.column !== undefined ? { column: bp.column } : {}),
            verified,
            ...(message !== undefined ? { message } : {}),
          },
        ];
      });
    return { file: sourcePath, breakpoints: snapshot };
  }

  /**
   * DAP `breakpoint` 事件:adapter 事后更新断点状态(js-debug 在 child 连接上把 provisional 断点更新为
   * verified / 校正行)。只处理 reason 'changed' —— 'new' / 'removed' 不是 Continuo 发起的断点。
   * 按「连接 + id」找记录(id 按连接各自编号,跨连接会串号),更新回报并推该 source 的快照。
   */
  private handleBreakpointEvent(
    sessionId: string,
    client: DebugDapClientLike,
    body: unknown,
  ): void {
    const runtime = this.requireRuntime(sessionId); // 调用方已用 isLiveClient 确认会话在
    const event = asRecord(body);
    if (stringField(event, 'reason') !== 'changed') return;
    const breakpoint = asRecord(event.breakpoint);
    const id = numberField(breakpoint, 'id');
    if (id === undefined) return;
    const record = runtime.breakpoints.find((bp) => bp.ids.get(client) === id);
    if (!record) {
      // 可能是 setBreakpoints 响应与它同 chunk 到达、续体还没登记新 id:暂存(同 id 覆盖保留最新),
      // rememberBreakpointReports 登记后补上。
      const pending = runtime.pendingBreakpointChanges.get(client) ?? new Map();
      pending.delete(id);
      pending.set(id, breakpoint);
      if (pending.size > MAX_PENDING_BREAKPOINT_CHANGES) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      runtime.pendingBreakpointChanges.set(client, pending);
      return;
    }
    applyBreakpointChange(record, client, breakpoint);
    this.emitBreakpointSnapshot(sessionId, runtime, record.source);
  }

  /**
   * stopped 的 hitBreakpointIds:命中即该断点在这条连接上已绑定。js-debug 对纯 JS 起跑前设的断点,父连接与
   * child 重放都回 provisional 且不发 changed 事件,命中是唯一的绑定信号 —— 不记的话红点一直 pending。
   * 按「连接 + id」找记录,行沿用该连接上次回报的校正行。
   */
  private markHitBreakpointsVerified(
    sessionId: string,
    runtime: RuntimeDebugSession,
    client: DebugDapClientLike,
    bodyJson: DapJson | undefined,
  ): void {
    const sources = new Set<string>();
    for (const id of asArray(asRecord(bodyJson).hitBreakpointIds)) {
      const record = runtime.breakpoints.find((bp) => bp.ids.get(client) === id);
      if (!record || record.reportedBy.get(client)?.verified) continue;
      record.reportedBy.set(client, {
        line: record.reportedBy.get(client)?.line ?? record.line,
        verified: true,
      });
      sources.add(record.source);
    }
    for (const source of sources) this.emitBreakpointSnapshot(sessionId, runtime, source);
  }

  /** 重推该连接回报过的各 source 的快照(它的回报加入或退出聚合时)。 */
  private emitSnapshotsReportedBy(
    sessionId: string,
    runtime: RuntimeDebugSession,
    client: DebugDapClientLike,
  ): void {
    const sources = new Set(
      runtime.breakpoints.filter((bp) => bp.reportedBy.has(client)).map((bp) => bp.source),
    );
    for (const source of sources) this.emitBreakpointSnapshot(sessionId, runtime, source);
  }

  waitForStop(
    sessionId: string,
    input: WaitForStopInput,
  ): Promise<WaitForStopOutput> {
    const runtime = this.requireRuntime(sessionId);
    const session = this.requireSession(sessionId);
    const afterStopSeq = input.afterStopSeq ?? 0;
    if (runtime.endedMessage !== undefined) {
      return Promise.reject(new Error(runtime.endedMessage));
    }
    if (
      session.runtimeState === 'stopped' &&
      session.stopSeq > afterStopSeq &&
      runtime.currentStop
    ) {
      return Promise.resolve(runtime.currentStop);
    }

    const timeoutMs = input.timeoutMs;
    return new Promise((resolve, reject) => {
      const waiter: StopWaiter = {
        afterStopSeq,
        resolve,
        reject,
        timer: setTimeout(() => {
          runtime.waiters.delete(waiter);
          reject(codedError(ERROR_CODES.DEBUG_WAIT_TIMEOUT, 'debug wait_for_stop timed out'));
        }, timeoutMs),
      };
      runtime.waiters.add(waiter);
      // 等停点 = 要求程序在跑:没设断点就直接 wait_for_stop(如 stop_on_entry)时,程序此前从未起跑,会干等到
      // 超时。先同步登记 waiter 再起跑:登记之后的 teardown 照常结算它。起跑失败则摘掉 waiter 并以该错误 reject。
      this.ensureProgramStarted(runtime).catch((err: unknown) => {
        if (!runtime.waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        reject(toError(err));
      });
    });
  }

  // thread_id 解析。js-debug 的 Node 线程 id 是 0(合法,DAP threadId 允许 0),
  // 所以 provided 给定就直接透传(含 0);省略时优先用最近停点(stopped)记录的线程,无停点记录时才发
  // DAP threads 请求取首个线程。
  // DAP next/stepIn/stepOut/continue/stackTrace 都需要 threadId,故统一在此解析。
  private async resolveThreadId(
    sessionId: string,
    provided?: number,
  ): Promise<number> {
    if (provided !== undefined) return provided;
    // 优先用最近 stopped 事件记录的线程:多线程(worker)下这才是真正停住的那条,
    // 也省掉一次 threads 往返。0 是 Node 主线程的合法 id。
    const runtime = this.requireRuntime(sessionId);
    const stopped = runtime.currentStop?.thread_id;
    if (stopped !== undefined) return stopped;
    // 回退:无停点记录(如停点事件未带 threadId)→ threads 请求取首个线程。
    const response = await runtime.activeClient.sendRequest(
      'threads',
      {},
      this.requestTimeoutMs,
    );
    const threads = asArray(asRecord(response.body).threads);
    const first = threads[0];
    if (first !== undefined) {
      const id = numberField(asRecord(first as DapJson), 'id');
      if (id !== undefined) return id;
    }
    throw new Error('debug session has no active thread to resolve');
  }

  async continue(
    sessionId: string,
    input: { readonly threadId?: number },
  ): Promise<{ continued: boolean; all_threads_continued?: boolean }> {
    return this.resume(sessionId, 'continue', input);
  }

  async stepOver(sessionId: string, input: { readonly threadId?: number }) {
    return this.resume(sessionId, 'next', input);
  }

  async stepIn(sessionId: string, input: { readonly threadId?: number }) {
    return this.resume(sessionId, 'stepIn', input);
  }

  async stepOut(sessionId: string, input: { readonly threadId?: number }) {
    return this.resume(sessionId, 'stepOut', input);
  }

  async stackTrace(
    sessionId: string,
    input: { readonly threadId?: number; readonly startFrame?: number; readonly levels?: number },
  ): Promise<{ frames: readonly DebugStackFrame[]; total_frames?: number }> {
    const runtime = this.requireRuntime(sessionId);
    const threadId = await this.resolveThreadId(sessionId, input.threadId);
    const response = await runtime.activeClient.sendRequest(
      'stackTrace',
      {
        threadId,
        startFrame: input.startFrame ?? 0,
        levels: input.levels ?? DEBUG_STACK_LEVELS_DEFAULT,
      },
      this.requestTimeoutMs,
    );
    const body = asRecord(response.body);
    const frames = asArray(body.stackFrames).map((raw) => {
      const frame = asRecord(raw as DapJson);
      const source = asRecord(frame.source as DapJson | undefined);
      return {
        id: numberField(frame, 'id') ?? 0,
        name: stringField(frame, 'name') ?? '',
        ...(stringField(source, 'path') !== undefined
          ? { source_path: stringField(source, 'path') }
          : {}),
        line: numberField(frame, 'line') ?? 0,
        ...(numberField(frame, 'column') !== undefined
          ? { column: numberField(frame, 'column') }
          : {}),
      };
    });
    return {
      frames,
      ...(numberField(body, 'totalFrames') !== undefined
        ? { total_frames: numberField(body, 'totalFrames') }
        : {}),
    };
  }

  async scopes(
    sessionId: string,
    input: { readonly frameId: number },
  ): Promise<{ scopes: readonly DebugScope[] }> {
    const runtime = this.requireRuntime(sessionId);
    const response = await runtime.activeClient.sendRequest(
      'scopes',
      { frameId: input.frameId },
      this.requestTimeoutMs,
    );
    const body = asRecord(response.body);
    const scopes = asArray(body.scopes).map((raw) => {
      const scope = asRecord(raw as DapJson);
      return {
        name: stringField(scope, 'name') ?? '',
        variables_reference: numberField(scope, 'variablesReference') ?? 0,
        expensive: boolField(scope, 'expensive') ?? false,
      };
    });
    return { scopes };
  }

  async variables(
    sessionId: string,
    input: {
      readonly variablesReference: number;
      readonly start?: number;
      readonly count?: number;
      readonly maxDepth?: number;
      readonly maxStringBytes?: number;
      /** 调用方连接的 abort signal(MCP ctx.signal):断连后停止继续展开。 */
      readonly signal?: AbortSignal;
    },
  ): Promise<{
    readonly variables: readonly DebugVariable[];
    readonly truncated: boolean;
    readonly next_start?: number;
  }> {
    const runtime = this.requireRuntime(sessionId);
    const start = input.start ?? 0;
    const count = input.count ?? DEBUG_VARIABLE_COUNT_DEFAULT;
    const maxDepth = input.maxDepth ?? DEBUG_VARIABLE_DEPTH_DEFAULT;
    const maxStringBytes = input.maxStringBytes ?? DEBUG_STRING_BYTES_DEFAULT;
    const budget: VariablesBudget = {
      nodes: DEBUG_VARIABLES_EXPAND_MAX_NODES,
      requests: DEBUG_VARIABLES_EXPAND_MAX_REQUESTS,
      bytes: DEBUG_VARIABLES_EXPAND_MAX_BYTES,
      exhausted: false,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };
    const { variables, cut } = await this.readVariables(
      runtime,
      input.variablesReference,
      start,
      count,
      maxDepth,
      maxStringBytes,
      budget,
      true,
    );
    // 本页取满 count 条 = 可能还有更多:truncated 与 next_start 同步(此前 truncated 写死 false)。
    // 本页被字节预算截断同样还有更多,next_start 接在已返回的最后一项之后。
    // 展开预算用尽(有节点未展开,各自标了 truncated)同样报 truncated。
    const hasMore = cut || variables.length >= count;
    return {
      variables,
      truncated: hasMore || budget.exhausted,
      ...(hasMore ? { next_start: start + variables.length } : {}),
    };
  }

  async evaluate(
    sessionId: string,
    input: {
      readonly expression: string;
      readonly frameId?: number;
      readonly context?: 'watch' | 'repl' | 'hover';
      readonly maxResultBytes?: number;
    },
  ): Promise<{
    readonly result: string;
    readonly type?: string;
    readonly variables_reference?: number;
    readonly truncated: boolean;
  }> {
    const runtime = this.requireRuntime(sessionId);
    const response = await runtime.activeClient.sendRequest(
      'evaluate',
      {
        expression: input.expression,
        context: input.context ?? 'watch',
        ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
      },
      this.requestTimeoutMs,
    );
    const body = asRecord(response.body);
    const truncated = truncateUtf8(
      stringField(body, 'result') ?? '',
      input.maxResultBytes ?? DEBUG_EVALUATE_RESULT_BYTES_MAX,
    );
    return {
      result: truncated.value,
      ...(stringField(body, 'type') !== undefined
        ? { type: stringField(body, 'type') }
        : {}),
      ...(numberField(body, 'variablesReference') !== undefined
        ? { variables_reference: numberField(body, 'variablesReference') }
        : {}),
      truncated: truncated.truncated,
    };
  }

  // 始终终止 debuggee(teardown 按进程组整组回收)。MCP 入口 schema 只接受 terminate_debuggee=true,
  // 这里不再接受「不终止」的选项,免得某个调用方以为能只断开而被静默终止。
  async disconnect(sessionId: string): Promise<{ disconnected: boolean }> {
    await this.teardownSession(sessionId, 'disconnect terminate');
    return { disconnected: true };
  }

  listSessions(): readonly {
    readonly session_id: string;
    readonly state: string;
    readonly name?: string;
    readonly stopped_reason?: string;
    readonly owner_window_id: number;
  }[] {
    return debugSessions.list().map((session) => {
      const stoppedReason = this.runtimes.get(session.id)?.currentStop?.reason;
      return {
        session_id: session.id,
        state: session.runtimeState,
        ...(session.name !== undefined ? { name: session.name } : {}),
        ...(stoppedReason !== undefined ? { stopped_reason: stoppedReason } : {}),
        owner_window_id: session.ownerWindowId,
      };
    });
  }

  /**
   * renderer 订阅时的快照(只含该窗口、尚未拆除的会话):当前停点、按 source 的断点集合。renderer 重载后
   * store 为空,只靠增量事件恢复不了停点与断点。每个会话的断点总数封顶 DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX。
   */
  viewSnapshot(ownerWindowId: number): DebugViewSessionSnapshot[] {
    return debugSessions
      .byOwner(ownerWindowId)
      .filter((session) => session.state === 'active')
      .map((session) => {
        const runtime = this.runtimes.get(session.id);
        const stop = session.runtimeState === 'stopped' ? runtime?.currentStop : undefined;
        const groups: DebugViewSessionSnapshot['breakpointsBySource'][number][] = [];
        let budget = DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX;
        for (const source of runtime ? breakpointsBySource(runtime.breakpoints).keys() : []) {
          if (budget <= 0 || !runtime) break;
          const group = this.breakpointSnapshot(runtime, source);
          const breakpoints = group.breakpoints.slice(0, budget);
          budget -= breakpoints.length;
          groups.push({ file: group.file, breakpoints });
        }
        return {
          session_id: session.id,
          ...(stop
            ? {
                stop: { stopSeq: stop.stop_seq, reason: stop.reason },
              }
            : {}),
          breakpointsBySource: groups,
        };
      });
  }

  /**
   * 应用退出:取消全部在途 launch(各自在检查点释放已 spawn 的 adapter)并拆除已登记会话;等在途 launch 结算,
   * 最多 DEBUG_LAUNCH_SETTLE_WAIT_MS —— 否则退出时 detached 的 adapter 遗留。开始即置 shuttingDown(此后 launch
   * 一律拒绝),结束前再查一遍登记表,拆除清理期间漏网登记的会话。
   */
  async cleanupAll(reason: string): Promise<readonly string[]> {
    this.shuttingDown = true;
    const pending = this.cancelLaunches(() => true);
    const [ids] = await Promise.all([
      this.teardownMany(debugSessions.list(), reason),
      waitAtMost(Promise.all(pending), DEBUG_LAUNCH_SETTLE_WAIT_MS),
    ]);
    const stragglers = debugSessions.list().filter((session) => session.state === 'active');
    return [...ids, ...(await this.teardownMany(stragglers, reason))];
  }

  /** 窗口关闭:取消该窗口的在途 launch(否则随后登记到已销毁的窗口成为孤儿),拆除其已登记会话。 */
  async killByOwner(
    ownerWindowId: number,
    reason: string,
  ): Promise<readonly string[]> {
    this.cancelLaunches((launch) => launch.ownerWindowId === ownerWindowId);
    return this.teardownMany(debugSessions.byOwner(ownerWindowId), reason);
  }

  /**
   * 吊销调用方身份:取消该身份**此刻**在途的 launch(尚未登记,这里查不到会话)并拆除其已登记会话。吊销之后
   * 同一身份新发起的 launch 不受影响(stdio subject 固定,用户重新授权后须能照常 launch)。
   */
  async killByController(
    controllerToken: string,
    reason: string,
  ): Promise<readonly string[]> {
    this.cancelLaunches((launch) => launch.controllerToken === controllerToken);
    return this.teardownMany(debugSessions.byController(controllerToken), reason);
  }

  /** 持有 debug 会话或有在途 launch 的调用方身份(撤销授权据此逐个 killByController)。 */
  listControllerTokens(): readonly string[] {
    return Array.from(
      new Set([
        ...debugSessions.list().map((session) => session.controllerToken),
        ...Array.from(this.launches, (launch) => launch.controllerToken),
      ]),
    );
  }

  /**
   * continue / next / stepIn / stepOut 的共同实现:解析线程 → 发 DAP 请求 → 标记已恢复执行。
   * 请求成功即已恢复执行 —— DAP allThreadsContinued 仅表「是否所有线程都续」,js-debug 常返 false(只续
   * 单线程),不应让调用方误判没恢复;以后续 wait_for_stop 拿到下一停点为准。原始值仍放
   * all_threads_continued。
   */
  private async resume(
    sessionId: string,
    command: 'continue' | 'next' | 'stepIn' | 'stepOut',
    input: { readonly threadId?: number },
  ): Promise<{ continued: boolean; all_threads_continued?: boolean }> {
    const runtime = this.requireRuntime(sessionId);
    if (!runtime.launched) {
      // 程序还没起跑(launch 后未设断点就 continue / step):这一步就是「让它跑起来」。没有停住的线程可发
      // continue / step,起跑即返回;是否停住仍以随后的 wait_for_stop 为准。
      await this.ensureProgramStarted(runtime);
      if (runtime.currentStop === undefined) return { continued: true };
    }
    const threadId = await this.resolveThreadId(sessionId, input.threadId);
    // 记下发往哪条连接:它的 continued 事件可能先于响应到达并已触发「呈现下一个排队停点」,
    // 此时再不带连接地清一次,会把刚呈现的那个停点错清掉。
    const target = runtime.activeClient;
    // 同时记下发请求时的停点:响应与随后的 continued / stopped 可能在同一次 read 里到达,事件先于这里的
    // 续体被处理。那时停点已经换了(单步后的新停点,或接着呈现的排队停点),再清就会把新停点 / 该连接
    // 刚入队的停点抹掉 —— 只有停点仍是发请求时的那一个才由这里清。
    const stopAtSend = runtime.currentStop;
    const response = await target.sendRequest(command, { threadId }, this.requestTimeoutMs);
    if (runtime.currentStop === stopAtSend) this.markContinued(sessionId, target);
    const allThreadsContinued = boolField(asRecord(response.body), 'allThreadsContinued');
    return {
      continued: true,
      ...(allThreadsContinued !== undefined ? { all_threads_continued: allThreadsContinued } : {}),
    };
  }

  /** DAP initialize 握手:先挂 initialized 事件等待再发请求(事件可能先于响应到达)。 */
  private async initializeClient(client: DebugDapClientLike): Promise<void> {
    const initialized = client.waitForEvent('initialized', this.requestTimeoutMs);
    // 下面的 initialize 请求先失败时,这个等待之后超时 reject 不能成为未处理的 rejection。
    initialized.catch(() => undefined);
    await client.sendRequest('initialize', initializeArgs(), this.requestTimeoutMs);
    await initialized;
  }

  /**
   * 让程序起跑:configurationDone → launch,只做一次(并发调用共用同一个在途 Promise)。
   * 刻意推迟到第一个「要求程序运行」的调用(wait_for_stop / continue / step),而不是 debug.launch 时就起跑:
   * agent 的标准流程是 launch → set_breakpoint(可多个)→ wait_for_stop,断点要在程序运行之前就位。
   * 失败时清掉在途 Promise,下次调用可重试。
   */
  private ensureProgramStarted(runtime: RuntimeDebugSession): Promise<void> {
    runtime.programStart ??= this.startProgram(runtime).catch((err: unknown) => {
      runtime.programStart = undefined;
      throw err;
    });
    return runtime.programStart;
  }

  private async startProgram(runtime: RuntimeDebugSession): Promise<void> {
    if (!runtime.configurationDone) {
      await runtime.parentClient.sendRequest(
        'configurationDone',
        {},
        this.requestTimeoutMs,
      );
      runtime.configurationDone = true;
    }
    if (runtime.launched) return;
    await this.reverifyLaunchInsideWorkspace(runtime);
    runtime.parentClient.sendRequestNoWait('launch', this.launchArguments(runtime));
    runtime.launched = true;
    // 已结束 / 拆除中的会话不翻回 running(configurationDone 期间可能已 teardown)。
    if (runtime.endedMessage === undefined && debugSessions.get(runtime.id)?.runtimeState === 'starting') {
      debugSessions.update(runtime.id, { runtimeState: 'running' });
    }
  }

  /**
   * 起跑前复验 workspace 闸:launch 虽用校验时的真实路径,但校验与起跑之间可把该文件改名、原位换成指向
   * 工作区外的软链(Node 起跑时重新解析)。发 launch(父连接与 child 连接)前再走一次 realpath + inside;
   * 不通过则拒绝起跑:以该错误结算在途 wait_for_stop 并拆除会话。
   */
  private async reverifyLaunchInsideWorkspace(runtime: RuntimeDebugSession): Promise<void> {
    const session = debugSessions.get(runtime.id);
    if (!session) throw sessionNotFoundError();
    try {
      await this.assertLaunchInsideWorkspace(
        session.ownerWindowId,
        runtime.launch.program,
        runtime.launch.cwd,
      );
    } catch (err) {
      const error = toError(err);
      this.rejectWaiters(runtime.id, error);
      void this.teardownSession(runtime.id, 'launch-outside-workspace').catch(() => undefined);
      throw error;
    }
  }

  private launchArguments(runtime: RuntimeDebugSession): DapJson {
    const launch = runtime.launch;
    const cwd = launch.cwd;
    return {
      type: 'pwa-node',
      request: 'launch',
      name: launch.name ?? 'Continuo debug session',
      program: launch.program,
      cwd,
      // 固定 node:否则 js-debug 按 env 的 PATH 解析 `node`(见 findNodeRuntimeOnPath)。
      runtimeExecutable: runtime.runtimeExecutable,
      args: [...(launch.args ?? [])],
      ...(toEnvObject(launch.env) !== undefined ? { env: toEnvObject(launch.env) } : {}),
      console: 'internalConsole',
      outputCapture: 'std',
      sourceMaps: true,
      pauseForSourceMap: true,
      stopOnEntry: launch.stopOnEntry ?? false,
      autoAttachChildProcesses: false,
      outFiles: [`${cwd}/.out/**/*.js`],
      resolveSourceMapLocations: [`${cwd}/.out/**/*.js`, '!**/node_modules/**'],
    };
  }

  /**
   * js-debug 的反向请求 startDebugging:为一个新的调试目标建 child session。
   * `requester` 是收到请求的那条连接 —— 主目标的请求来自父连接;worker_threads 等嵌套目标的请求来自
   * **主目标的 child 连接**,所以 child 也要挂本 handler(否则回 unsupported,worker 一直停在等待调试器
   * 附加的状态,整个被调试程序卡死)。
   */
  private async handleStartDebugging(
    sessionId: string,
    request: DapRequestMessage,
    requester: DebugDapClientLike,
  ): Promise<DapJson> {
    const runtime = this.requireRuntime(sessionId);
    // 超出上限:抛错 → DapClient 回 success:false,js-debug 放弃附加该目标;不建 socket / DapClient。
    if (runtime.childClients.length >= debugSessions.MAX_DEBUG_CHILD_SESSIONS_PER_SESSION) {
      throw new Error(
        `debug child session limit (${debugSessions.MAX_DEBUG_CHILD_SESSIONS_PER_SESSION}) reached`,
      );
    }
    const child = requester.createChildSession();
    child.setStartDebuggingHandler((nested) => this.handleStartDebugging(sessionId, nested, child));
    runtime.childClients.push(child);
    debugSessions.update(sessionId, {
      childSessionCount: runtime.childClients.length,
    });
    this.wireClient(sessionId, child);
    try {
      await child.connectToServer();

      await this.initializeClient(child);
      // 每个 source 发一次完整集合(逐个断点发会让后一个覆盖前一个)。不同 source 并发发出:子目标在
      // configurationDone 之前一直停住,串行会让每个 child 付 K 次往返。每个响应到达即登记:重放在途时
      // 用户对同一 child 发的同 source 集合在 adapter 侧排在重放之后、其回报也随响应即时登记,推迟到最慢
      // source 返回再登记会让旧的重放回报覆盖它。已被摘除(失败回滚 / 结束回收)的 child 不再登记;任一失败
      // 进 catch 回滚(forgetClient 清掉该 child 的全部回报,与串行时一致)。
      await Promise.all(
        [...breakpointsBySource(runtime.breakpoints)].map(([source, records]) =>
          this.sendBreakpointsTo(
            runtime,
            child,
            setBreakpointsArgs(runtime.adapterPaths.get(source) ?? source, records),
            records,
          ),
        ),
      );
      await child.sendRequest('configurationDone', {}, this.requestTimeoutMs);
    } catch (err) {
      // child 没建起来:摘掉它,activeClient 保持原样(父 client 仍可用)。若在连接前就切过去,
      // 后续 stack / variables / continue 会全部打到一个死 client 上。
      const index = runtime.childClients.indexOf(child);
      if (index >= 0) runtime.childClients.splice(index, 1);
      forgetClient(runtime, child);
      debugSessions.update(sessionId, { childSessionCount: runtime.childClients.length });
      await child.dispose().catch(() => undefined);
      // 摘除后重新判定:若其余 child 在这次握手期间都已结束,存活的 child 已全部结束 → 整个会话结束
      //(否则要等父 client 的 terminated 才收敛)。
      if (runtime.endedMessage === undefined && this.allChildrenEnded(runtime)) {
        this.endWholeSession(sessionId, runtime, 'debug session terminated');
      }
      throw err;
    }
    // 真正起 Node 的是这条 child 连接上的 launch:父 launch 之后路径仍可能被换,发之前再复验
    //(放在下面的「已结束」判定之前:复验是异步边界,判定须在其后)。
    await this.reverifyLaunchInsideWorkspace(runtime);
    // 握手期间已结束并被回收(markEnded):不再把它设为活动连接、也不再对它发 launch。
    if (!runtime.childClients.includes(child)) return {};
    // 握手完成、即将发 launch 时:第一个 child(主目标)成为活动连接。之后再出现的 child(worker 等)不抢
    // 活动连接 —— 哪条连接上停住了,markStopped 再把它切成活动连接。
    if (runtime.activeClient === runtime.parentClient) runtime.activeClient = child;
    // 重放响应写入了 child 的回报(可能与父连接不同),聚合结果随之变化。
    this.emitSnapshotsReportedBy(sessionId, runtime, child);

    const args = asRecord(request.arguments);
    const configuration = asRecord(args.configuration as DapJson | undefined);
    child.sendRequestNoWait(
      stringField(args, 'request') ?? 'launch',
      {
        ...configuration,
        ...asRecord(this.launchArguments(runtime)),
      } as DapJson,
    );
    return {};
  }

  private wireClient(sessionId: string, client: DebugDapClientLike): void {
    client.on('process', (event) => {
      const body = asRecord(event.body);
      const pid = numberField(body, 'systemProcessId');
      const runtime = this.runtimes.get(sessionId);
      // 已结束的会话 / 已回收的连接上迟到的 process 事件不再登记:其进程已结束,pid 随时可能被复用。
      if (pid === undefined || !runtime || runtime.endedMessage !== undefined) return;
      if (!this.isLiveClient(sessionId, client)) return;
      const pids = runtime.processIdsByClient.get(client) ?? [];
      if (!pids.includes(pid)) pids.push(pid);
      runtime.processIdsByClient.set(client, pids);
      debugSessions.addSystemProcessId(sessionId, pid);
    });
    // 已回收的 child(同一 chunk 里排在 terminated 之后的事件)不再改停点 / 断点记录,免得重新引用它。
    client.on('stopped', (event) => {
      if (this.isLiveClient(sessionId, client)) this.markStopped(sessionId, event.body, client);
    });
    client.on('continued', () => this.markContinued(sessionId, client));
    client.on('breakpoint', (event) => {
      if (this.isLiveClient(sessionId, client)) {
        this.handleBreakpointEvent(sessionId, client, event.body);
      }
    });
    client.on('terminated', () => this.markEnded(sessionId, client, 'debug session terminated'));
    client.on('exited', () => this.markEnded(sessionId, client, 'debug session exited'));
  }

  /**
   * debuggee 结束(terminated / exited)。若事件代表整个会话结束(见下),结算在途的 wait_for_stop 并
   * 把会话标成 terminated(迟到的 stopped / continued 不再翻回)—— 之后的 wait_for_stop 立即报已终止(否则干等满 timeout 才报超时),list_sessions
   * 也不再显示 running。adapter 进程仍由 disconnect / 关窗 / 退出时的 teardown 回收。
   */
  private markEnded(sessionId: string, client: DebugDapClientLike, message: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    // 父 client 结束 = 整个会话结束。child 结束则记下来,全部 child 都结束才算(单进程调试只有一个 child);
    // 有多个 child(worker 等)时某一个先退出不代表会话结束 —— 既不结算在途的 wait_for_stop,也不置位
    //(置位后 wait_for_stop 会永久报已终止)。
    if (client !== runtime.parentClient) {
      // 结束的 child 当即回收:移出 childClients、清掉各断点记录里它的条目、dispose。同一 child 的第二个结束
      // 事件(terminated 之后的 exited)或握手失败已摘除的 child 找不到 → 已处理过。
      const index = runtime.childClients.indexOf(client);
      if (index < 0) return;
      runtime.childClients.splice(index, 1);
      runtime.childEnded = true;
      debugSessions.update(sessionId, { childSessionCount: runtime.childClients.length });
      // 它的 debuggee 已结束:pid 移出记录,之后的清理不再按这个(可能被复用的)pid 杀进程。
      debugSessions.removeSystemProcessIds(sessionId, runtime.processIdsByClient.get(client) ?? []);
      runtime.processIdsByClient.delete(client);
      // 清记录前先取它回报过的 source(快照要重推)。
      const reportedSources = new Set(
        runtime.breakpoints.filter((bp) => bp.reportedBy.has(client)).map((bp) => bp.source),
      );
      forgetClient(runtime, client);
      // 不当即关连接:js-debug 可能在 terminated 之后才回这条连接上在途请求(continue / stackTrace 等)的
      // 响应,当即 dispose 会让它们以「DAP socket closed」失败。等在途请求结算(各有超时,有界)再回收。
      void client.disposeWhenIdle().catch(() => undefined);
      if (!this.allChildrenEnded(runtime)) {
        this.dropEndedChildStops(sessionId, runtime, client);
        // 它的回报不再参与聚合:红点回落到其余连接的回报。
        for (const source of reportedSources) this.emitBreakpointSnapshot(sessionId, runtime, source);
        return;
      }
    }
    this.endWholeSession(sessionId, runtime, message);
  }

  /**
   * 一个 child 结束了但会话还在:它的停点(排队中的 / 当前呈现的)作废;若它是活动连接,把活动连接换成
   * 仍存活的 child,免得后续请求打到已结束的连接上。
   */
  private dropEndedChildStops(
    sessionId: string,
    runtime: RuntimeDebugSession,
    client: DebugDapClientLike,
  ): void {
    const index = runtime.queuedStops.findIndex((entry) => entry.client === client);
    if (index >= 0) runtime.queuedStops.splice(index, 1);
    if (runtime.stoppedClient === client) this.markContinued(sessionId, client);
    if (runtime.activeClient === client) {
      runtime.activeClient = runtime.childClients[0] ?? runtime.parentClient;
    }
  }

  /**
   * 向一条连接下发某 source 的完整断点集合并登记它的回报。等待期间该连接已结束并被回收 → 不再登记
   *(否则又留下对已回收连接的引用)。`timeoutCapMs` 给定时超时取 min(requestTimeoutMs, cap):同步 / 回滚
   * 不能被某个不应答的 child 拖到整份超时;child 建立时的重放用完整超时。
   */
  private async sendBreakpointsTo(
    runtime: RuntimeDebugSession,
    client: DebugDapClientLike,
    args: DapJson,
    records: readonly BreakpointRecord[],
    timeoutCapMs?: number,
  ): Promise<void> {
    const timeoutMs =
      timeoutCapMs === undefined ? this.requestTimeoutMs : Math.min(this.requestTimeoutMs, timeoutCapMs);
    const response = await client.sendRequest('setBreakpoints', args, timeoutMs);
    if (client === runtime.parentClient || runtime.childClients.includes(client)) {
      rememberBreakpointReports(runtime, client, records, response);
    }
  }

  private isLiveClient(sessionId: string, client: DebugDapClientLike): boolean {
    const runtime = this.runtimes.get(sessionId);
    return (
      runtime !== undefined &&
      (client === runtime.parentClient || runtime.childClients.includes(client))
    );
  }

  /** 有 child 结束过且已没有存活 / 握手中的 child(结束的 child 已从 childClients 移除)。 */
  private allChildrenEnded(runtime: RuntimeDebugSession): boolean {
    return runtime.childEnded && runtime.childClients.length === 0;
  }

  private endWholeSession(sessionId: string, runtime: RuntimeDebugSession, message: string): void {
    this.rejectWaiters(sessionId, new Error(message));
    runtime.endedMessage = message;
    // 整个会话结束:debuggee 都已结束,清空 pid 记录(terminated 会话可能保留到名额满才回收,其间 pid 会被复用);
    // 此后清理只需回收 adapter。
    runtime.processIdsByClient.clear();
    debugSessions.update(sessionId, { runtimeState: 'terminated', systemProcessIds: [] });
  }

  private markStopped(
    sessionId: string,
    bodyJson: DapJson | undefined,
    client: DebugDapClientLike,
  ): void {
    const runtime = this.requireRuntime(sessionId); // 两个调用方都已确认会话在
    if (runtime.endedMessage !== undefined) return; // 已结束:迟到事件不翻回状态
    // 排队与否都先记下命中:绑定是既成事实。
    this.markHitBreakpointsVerified(sessionId, runtime, client, bodyJson);
    // 当前停点还没恢复、而这次停在另一条连接上 → 排队(同一连接的旧排队项被替换),稍后再呈现。
    if (
      runtime.currentStop !== undefined &&
      runtime.stoppedClient !== undefined &&
      runtime.stoppedClient !== client
    ) {
      const queued = runtime.queuedStops;
      const index = queued.findIndex((entry) => entry.client === client);
      if (index >= 0) queued.splice(index, 1);
      queued.push({ client, body: bodyJson });
      return;
    }
    // 停在哪条连接上,后续的 stack / scopes / variables / continue 就发给哪条连接(主线程或某个 worker)。
    runtime.activeClient = client;
    runtime.stoppedClient = client;
    const body = asRecord(bodyJson);
    const session = this.requireSession(sessionId);
    const stopSeq = session.stopSeq + 1;
    // js-debug 在 parent/child 配置下命中断点时仍发 reason:'entry'(真实原因在
    // description='Paused on breakpoint' + hitBreakpointIds:[...])。hitBreakpointIds
    // 是 DAP 标准的断点命中权威信号:非空即归一为 'breakpoint'(step/真 entry 不带,保留原 reason)。
    const rawReason = stringField(body, 'reason') ?? 'stopped';
    const reason =
      asArray(body.hitBreakpointIds).length > 0 ? 'breakpoint' : rawReason;
    const output: WaitForStopOutput = {
      session_id: sessionId,
      stop_seq: stopSeq,
      reason,
      ...(numberField(body, 'threadId') !== undefined
        ? { thread_id: numberField(body, 'threadId') }
        : {}),
      ...(stringField(body, 'description') !== undefined
        ? { description: stringField(body, 'description') }
        : {}),
    };
    runtime.currentStop = output;
    debugSessions.update(sessionId, { runtimeState: 'stopped', stopSeq });
    this.emitSessionEvent(sessionId, {
      type: 'stopped',
      sessionId,
      stopSeq,
      reason: output.reason,
    });

    for (const waiter of Array.from(runtime.waiters)) {
      if (stopSeq <= waiter.afterStopSeq) continue;
      clearTimeout(waiter.timer);
      runtime.waiters.delete(waiter);
      waiter.resolve(output);
    }
  }

  /**
   * 某条连接恢复运行(它发来的 continued 事件、我们对它发的 resume 成功,或它已结束)。
   * 只有当前停点所在的那条连接恢复才清停点:别的连接的 continued(worker 启动时的内部暂停恢复等)不算。
   * 清掉之后若还有排队的停点,立刻呈现下一个。
   */
  private markContinued(sessionId: string, client: DebugDapClientLike): void {
    const session = this.requireSession(sessionId);
    const runtime = this.requireRuntime(sessionId);
    if (runtime.endedMessage !== undefined) return; // 已结束:迟到事件 / 迟到的 resume 不翻回状态
    // 该连接已恢复:它若有排队中的停点,作废。
    const queuedIndex = runtime.queuedStops.findIndex((entry) => entry.client === client);
    if (queuedIndex >= 0) runtime.queuedStops.splice(queuedIndex, 1);
    if (runtime.stoppedClient !== undefined && runtime.stoppedClient !== client) return;
    if (session.runtimeState === 'running' && runtime.currentStop === undefined) {
      return;
    }
    runtime.currentStop = undefined;
    runtime.stoppedClient = undefined;
    debugSessions.update(sessionId, { runtimeState: 'running' });
    this.emitSessionEvent(sessionId, {
      type: 'continued',
      sessionId,
    });
    const next = runtime.queuedStops.shift();
    if (next) this.markStopped(sessionId, next.body, next.client);
  }

  private emitSessionEvent(sessionId: string, event: DebugViewEvent): void {
    const sink = this.eventSink;
    if (!sink) return;
    const session = debugSessions.get(sessionId);
    if (!session) return;
    sink.emit(session.ownerWindowId, event);
  }

  private rejectWaiters(sessionId: string, err: Error): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    for (const waiter of Array.from(runtime.waiters)) {
      clearTimeout(waiter.timer);
      runtime.waiters.delete(waiter);
      waiter.reject(err);
    }
  }

  private async readVariables(
    runtime: RuntimeDebugSession,
    variablesReference: number,
    start: number,
    count: number,
    maxDepth: number,
    maxStringBytes: number,
    budget: VariablesBudget,
    topLevel = false,
  ): Promise<{ readonly variables: readonly DebugVariable[]; readonly cut: boolean }> {
    if (budget.signal?.aborted) throw variablesCancelledError();
    budget.requests -= 1;
    const response = await runtime.activeClient.sendRequest(
      'variables',
      {
        variablesReference,
        start,
        count,
      },
      this.requestTimeoutMs,
    );
    const body = asRecord(response.body);
    const variables: DebugVariable[] = [];
    // adapter 多回的项不收(节点预算按 count 预留)。
    const items = asArray(body.variables).slice(0, count);
    budget.nodes -= items.length;
    for (const raw of items) {
      const variable = asRecord(raw as DapJson);
      const name = stringField(variable, 'name') ?? '';
      const type = stringField(variable, 'type');
      const rawValue = stringField(variable, 'value') ?? '';
      const truncated = truncateUtf8(rawValue, maxStringBytes);
      // 字节预算不够放下这一项:本页到此为止(cut)。顶层首项例外,保证分页总能前进。
      const itemBytes = utf8ByteLength(name) + utf8ByteLength(truncated.value) + utf8ByteLength(type ?? '');
      if (itemBytes > budget.bytes && !(topLevel && variables.length === 0)) {
        budget.exhausted = true;
        return { variables, cut: true };
      }
      budget.bytes -= itemBytes;
      const childRef = numberField(variable, 'variablesReference') ?? 0;
      let children: readonly DebugVariable[] | undefined;
      let unexpanded = false;
      if (maxDepth > 1 && childRef > 0) {
        // 预算还够一整页 count 才展开(子列表不会被节点预算截成半页);不够则保留 variables_reference 供调用方
        // 单独再取,并标 truncated。子列表被字节预算截断时同样标 truncated。
        if (budget.requests > 0 && budget.nodes >= count && budget.bytes > 0) {
          const expanded = await this.readVariables(
            runtime,
            childRef,
            0,
            count,
            maxDepth - 1,
            maxStringBytes,
            budget,
          );
          children = expanded.variables;
          unexpanded = expanded.cut;
        } else {
          budget.exhausted = true;
          unexpanded = true;
        }
      }
      variables.push({
        name,
        value: truncated.value,
        ...(type !== undefined ? { type } : {}),
        ...(childRef > 0 ? { variables_reference: childRef } : {}),
        ...(truncated.truncated || unexpanded ? { truncated: true } : {}),
        ...(children !== undefined ? { children } : {}),
      });
    }
    return { variables, cut: false };
  }

  private async teardownMany(
    sessions: readonly debugSessions.DebugSession[],
    reason: string,
  ): Promise<readonly string[]> {
    const ids = sessions.map((session) => session.id);
    await Promise.all(ids.map((id) => this.teardownSession(id, reason)));
    return ids;
  }

  private teardownSession(sessionId: string, reason: string): Promise<void> {
    const existing = this.teardownInFlight.get(sessionId);
    if (existing) return existing;
    const first = debugSessions.tryMarkTearingDown(sessionId);
    if (!first) return Promise.resolve();

    const task = this.doTeardownSession(sessionId, reason).finally(() => {
      this.emitSessionEvent(sessionId, {
        type: 'terminated',
        sessionId,
      });
      debugSessions.remove(sessionId);
      this.runtimes.delete(sessionId);
      this.teardownInFlight.delete(sessionId);
    });
    this.teardownInFlight.set(sessionId, task);
    return task;
  }

  private async doTeardownSession(sessionId: string, reason: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    const session = debugSessions.get(sessionId);
    this.rejectWaiters(sessionId, new Error(`debug session disconnected: ${reason}`));
    if (!runtime || !session) return;

    let firstError: Error | null = null;
    const clients = [runtime.parentClient, ...runtime.childClients];
    // DAP adapters often stop replying while the debuggee is already exiting.
    // Lifecycle cleanup is judged by the process-group/tree kill below.
    await waitAtMost(
      Promise.allSettled(
        clients.map((client) =>
          client.sendRequest(
            'disconnect',
            { terminateDebuggee: true, restart: false },
            DEBUG_TEARDOWN_DISCONNECT_TIMEOUT_MS,
          ),
        ),
      ),
      DEBUG_TEARDOWN_DISCONNECT_TIMEOUT_MS,
    );

    try {
      // 不依据已知失效的 pid 杀进程:adapter 已退出则不再对其 pid 发信号;已结束的 debuggee 其 pid 已在
      // 结束时移出 systemProcessIds(上面 disconnect 期间结束的也已移出,故这里重读)。
      // POSIX 按 adapter 的进程组杀,仅限 adapter 仍存活(组必在、pgid 未复用);adapter 已退出时组已在退出那一刻
      // 处理(reapAdapterGroupOnExit),之后 pgid 可能已被复用,不再凭它枚举 / 发信号。
      // Windows 无进程组(launch 不记 pgid;adapter 存活时 teardown 以 adapter pid 充当 taskkill 根):adapter 已退出且
      // 无记录在案的 debuggee → 只释放 client。
      // 残留风险:debuggee 未经 DAP 通知就退出、且其 pid 在会话存活期间被复用的极窄窗口(Windows taskkill /T)。
      await runtime.adapterExitReap;
      const current = debugSessions.get(sessionId) ?? session;
      const adapterAlive = runtime.parentClient.serverExited !== true;
      const liveAdapterPid = adapterAlive ? current.adapterPid : undefined;
      const adapterInfo =
        current.adapterPgid !== undefined || !adapterAlive
          ? null
          : await this.processOps.processInfo(current.adapterPid);
      const pgid = current.adapterPgid ?? adapterInfo?.pgid ?? current.adapterPid;
      const windowsDebuggees = platform() === 'win32' && current.systemProcessIds.length > 0;
      if (pgid && (adapterAlive || windowsDebuggees)) {
        debugSessions.update(sessionId, { adapterPgid: pgid });
        const groupBefore = await this.processOps.pidsInProcessGroup(pgid);
        const watchedPids = Array.from(
          new Set(
            [
              liveAdapterPid,
              ...current.systemProcessIds,
              ...groupBefore.map((entry) => entry.pid),
            ].filter((pid): pid is number => typeof pid === 'number' && pid > 0),
          ),
        );
        const alive = await this.processOps.terminateProcessGroup(pgid, watchedPids);
        if (alive.length > 0) {
          throw new Error(`debug teardown left alive pids: ${alive.join(',')}`);
        }
      }
    } catch (err) {
      firstError ??= toError(err);
    }

    try {
      await runtime.parentClient.dispose();
    } catch (err) {
      firstError ??= toError(err);
    }
    if (firstError) throw firstError;
  }

  /**
   * adapter 退出那一刻(POSIX)按其进程组回收残留的同组子孙:进程组只要还有成员就不会被复用,此刻组内存活的
   * 成员必是 adapter 派生、未脱离组的进程;组空则什么也不做。之后 pgid 可被系统复用给无关进程组,teardown
   * 不再凭它枚举 / 发信号。残留窗口:exit 事件到达与枚举之间(毫秒级)组恰好清空且 pgid 被复用。
   * Windows 无进程组可枚举(pidsInProcessGroup 返回空),此路径对其为 no-op。
   */
  private async reapAdapterGroupOnExit(sessionId: string): Promise<void> {
    const pgid = debugSessions.get(sessionId)?.adapterPgid;
    if (pgid === undefined) return;
    try {
      const members = await this.processOps.pidsInProcessGroup(pgid);
      if (members.length === 0) return;
      await this.processOps.terminateProcessGroup(
        pgid,
        members.map((entry) => entry.pid),
      );
    } catch {
      // 尽力而为:回收失败不影响会话后续的 teardown(teardown 不再凭旧 pgid 动手)
    }
  }

  private requireRuntime(sessionId: string): RuntimeDebugSession {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw sessionNotFoundError();
    return runtime;
  }

  private requireSession(sessionId: string): debugSessions.DebugSession {
    const session = debugSessions.get(sessionId);
    if (!session) throw sessionNotFoundError();
    return session;
  }
}
