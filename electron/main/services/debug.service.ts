import { execFile as execFileCb } from 'node:child_process';
import { asRecord } from '../../shared/as-record';
import { realpath } from 'node:fs/promises';
import { platform } from 'node:os';
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
import type { DebugViewEvent } from '../../shared/debug-view-channels';
import { codedError } from '../../shared/error-message';
import { runSerialPerKey } from './serialize-per-key';
import { lowerIfNeeded } from '../../shared/lower-if-needed';

const execFile = promisify(execFileCb);

export interface DebugDapClientLike {
  readonly socketPath?: string | null;
  readonly tcpPort?: number;
  readonly serverPid?: number;
  spawnServer(): Promise<this>;
  connectToServer(): Promise<this>;
  createChildSession(options?: unknown): DebugDapClientLike;
  setStartDebuggingHandler(
    handler:
      | ((
          request: DapRequestMessage,
          client: DebugDapClientLike,
        ) => Promise<DapJson | undefined> | DapJson | undefined)
      | null,
  ): void;
  on(eventName: string, callback: (event: DapEventMessage) => void): () => void;
  waitForEvent(eventName: string, timeoutMs?: number): Promise<DapEventMessage>;
  sendRequest(
    command: string,
    args?: DapJson,
    timeoutMs?: number,
  ): Promise<DapResponseMessage>;
  sendRequestNoWait(command: string, args?: DapJson): number;
  dispose(): Promise<void>;
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
    reason: string,
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
  readonly createDapClient?: (options: {
    adapterPath: string;
    requestTimeoutMs: number;
  }) => DebugDapClientLike;
  readonly processOps?: DebugProcessOps;
  readonly eventSink?: DebugEventSink;
  readonly workspace?: DebugWorkspaceGuard;
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
}

export interface SetBreakpointInput {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
}

export interface WaitForStopInput {
  readonly afterStopSeq?: number;
  readonly timeoutMs?: number;
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
  readonly parentClient: DebugDapClientLike;
  activeClient: DebugDapClientLike;
  readonly childClients: DebugDapClientLike[];
  readonly launch: LaunchSessionInput;
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
   * 各连接上按 id 查不到记录的 breakpoint changed 事件(id → 最新的 breakpoint 体)。DapClient 在同一 chunk 里
   * 先 resolve setBreakpoints 响应、再同步分发紧随其后的事件,await 续体登记新 id 之前事件就到了;登记 id 后补上。
   * 有上限(超出丢最旧的)。
   */
  readonly pendingBreakpointChanges: Map<DebugDapClientLike, Map<number, Record<string, unknown>>>;
  initialized: boolean;
  configurationDone: boolean;
  launched: boolean;
  /** configurationDone + launch 的在途 / 已完成 Promise(并发的 wait_for_stop / continue 只起跑一次)。 */
  programStart?: Promise<void>;
  currentStop?: WaitForStopOutput;
  /** debuggee 已结束(terminated / exited)时的说明;置位后 wait_for_stop 立即以它 reject。 */
  endedMessage?: string;
  /** 已发过 terminated / exited 的 child。 */
  readonly endedChildren: Set<DebugDapClientLike>;
  /** 当前呈现的停点发生在哪条连接上(currentStop 有值时才有意义)。 */
  stoppedClient?: DebugDapClientLike;
  /**
   * 当前停点尚未恢复时,别的连接上又发生的停点(主线程与 worker 各命中一个断点)。会话一次只呈现一个停点,
   * 其余在此排队;当前停点恢复后依次呈现 —— 否则后停的会把先停的顶掉,先停的那条连接再也没法被继续。
   */
  readonly queuedStops: Array<{ client: DebugDapClientLike; body: DapJson | undefined }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  const liveChildren = runtime.childClients.filter((child) => !runtime.endedChildren.has(child));
  const reports = [...liveChildren, runtime.parentClient].flatMap((client) => {
    const report = record.reportedBy.get(client);
    return report ? [report] : [];
  });
  return (
    reports.find((report) => report.verified) ??
    record.reportedBy.get(runtime.parentClient) ??
    reports[0]
  );
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

function getClientPid(client: DebugDapClientLike): number | undefined {
  return typeof client.serverPid === 'number' ? client.serverPid : undefined;
}

function makeSessionId(): string {
  return `debug-${crypto.randomUUID()}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8Bytes(value) <= maxBytes) return { value, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const next = bytes + utf8Bytes(char);
    if (next > maxBytes) break;
    bytes = next;
    end += char.length;
  }
  return { value: value.slice(0, end), truncated: true };
}

async function defaultProcessInfo(pid: number | undefined): Promise<ProcessInfo | null> {
  if (!pid || process.platform === 'win32') return null;
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
  if (!pgid || process.platform === 'win32') return [];
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
  if (process.platform === 'win32') {
    // Windows tree kill is deferred to the platform follow-up; direct pids are the only local fallback here.
    for (const pid of watchedPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore process-exit races
      }
    }
    return waitForDead(watchedPids, 3_000);
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
  private readonly createDapClient: (options: {
    adapterPath: string;
    requestTimeoutMs: number;
  }) => DebugDapClientLike;
  private readonly processOps: DebugProcessOps;
  private readonly workspace: DebugWorkspaceGuard;
  private readonly runtimes = new Map<string, RuntimeDebugSession>();
  private readonly teardownInFlight = new Map<string, Promise<void>>();
  /** 按 session + source 串行 setBreakpoints(读集合→下发→回滚/推快照整段不交错)。 */
  private readonly breakpointChains = new Map<string, Promise<unknown>>();
  private eventSink: DebugEventSink | null;

  constructor(options: DebugServiceOptions = {}) {
    this.adapterPath =
      options.adapterPath ??
      (options.createDapClient ? '__injected-debug-adapter__' : null);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.createDapClient =
      options.createDapClient ??
      ((clientOptions) =>
        new DapClient({
          adapterPath: clientOptions.adapterPath,
          requestTimeoutMs: clientOptions.requestTimeoutMs,
        }));
    this.processOps = options.processOps ?? DEFAULT_PROCESS_OPS;
    this.workspace = options.workspace ?? DEFAULT_WORKSPACE_GUARD;
    this.eventSink = options.eventSink ?? null;
  }

  // 安全闸:program/cwd 必须落在 owner window 的 workspace 内(realpath 后比较,防
  // symlink 逃逸与 `..` 穿越)。无 workspace 记录 → fail-closed 拒绝。
  private async assertLaunchInsideWorkspace(
    ownerWindowId: number,
    program: string,
    cwd: string,
  ): Promise<void> {
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
    await this.assertPathInside(realRoot, program, 'program');
    await this.assertPathInside(realRoot, cwd, 'cwd');
  }

  private async assertPathInside(
    realRoot: string,
    target: string,
    label: 'program' | 'cwd',
  ): Promise<void> {
    let realTarget: string;
    try {
      realTarget = await this.workspace.realpath(target);
    } catch {
      throw codedError(ERROR_CODES.DEBUG_PROGRAM_OUTSIDE_WORKSPACE, `debug ${label} not found or inaccessible: ${target}`);
    }
    const rel = path.relative(realRoot, realTarget);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (!inside) {
      throw codedError(ERROR_CODES.DEBUG_PROGRAM_OUTSIDE_WORKSPACE, `debug ${label} must be inside the workspace: ${target}`);
    }
  }

  setEventSink(eventSink: DebugEventSink | null): void {
    this.eventSink = eventSink;
  }

  async launchSession(
    input: LaunchSessionInput,
    ctx: DebugCallerContext,
  ): Promise<{ session_id: string; state: 'starting' | 'running' | 'stopped' }> {
    // 安全闸:先验 program/cwd 落在 workspace 内,再花成本 spawn adapter。
    // cwd 省略时默认 workspace root(不再回退 main 进程 cwd)。
    const root = this.workspace.getWorkspaceRoot(ctx.ownerWindowId);
    const effectiveCwd = input.cwd ?? root ?? process.cwd();
    await this.assertLaunchInsideWorkspace(
      ctx.ownerWindowId,
      input.program,
      effectiveCwd,
    );
    const normalizedInput: LaunchSessionInput = { ...input, cwd: effectiveCwd };
    // 会话数已满就别 spawn adapter(否则 add 抛错时 adapter 进程 / socket 已经起来了)。
    debugSessions.assertCapacity(ctx.ownerWindowId);

    const id = makeSessionId();
    const parentClient = this.createDapClient({
      adapterPath: this.resolveAdapterPathLazy(),
      requestTimeoutMs: this.requestTimeoutMs,
    });

    try {
      await parentClient.spawnServer();
    } catch (err) {
      // 此时还没登记 runtime / session,cleanupAll、killByOwner 都找不到这个 client;不在这里释放,
      // detached 的 adapter 进程和 socket 文件就成了孤儿(app 退出也不回收)。
      await parentClient.dispose().catch(() => undefined);
      throw err;
    }
    const adapterPid = getClientPid(parentClient);
    const adapterInfo = await this.processOps.processInfo(adapterPid);
    const runtime: RuntimeDebugSession = {
      id,
      parentClient,
      activeClient: parentClient,
      childClients: [],
      launch: normalizedInput,
      waiters: new Set(),
      endedChildren: new Set(),
      queuedStops: [],
      breakpoints: [],
      sourcePaths: new Map(),
      adapterPaths: new Map(),
      pendingBreakpointChanges: new Map(),
      initialized: false,
      configurationDone: false,
      launched: false,
    };
    try {
      debugSessions.add({
        id,
        ownerWindowId: ctx.ownerWindowId,
        controllerToken: ctx.controllerToken,
        program: input.program,
        cwd: effectiveCwd,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(adapterPid !== undefined ? { adapterPid } : {}),
      });
    } catch (err) {
      // spawn 期间别的 launch 占满了名额:session 没登记上,teardown 找不到它 → 就地释放 adapter。
      await parentClient.dispose().catch(() => undefined);
      throw err;
    }
    this.runtimes.set(id, runtime);
    if (adapterInfo) debugSessions.update(id, { adapterPgid: adapterInfo.pgid });
    this.wireClient(id, parentClient);
    parentClient.setStartDebuggingHandler((request) =>
      this.handleStartDebugging(id, request, parentClient),
    );

    try {
      await this.initializeClient(parentClient);
    } catch (err) {
      // session 已登记、adapter 活着,但调用方只会拿到错误、拿不到 session_id → 自己拆掉。
      await this.teardownSession(id, 'launch-failed').catch(() => undefined);
      throw err;
    }
    runtime.initialized = true;
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
    // js-debug 按 Node 实际加载的真实路径匹配脚本:发给 adapter 的 path 与分组键基于 realpath(软链拼写与真实
    // 拼写归为同一 source)。文件不存在 / realpath 失败时沿用原路径,不报错。
    const realFile = await this.workspace.realpath(input.file).catch(() => input.file);
    // 同 session 同 source 串行:并发时 B 捕获的完整集合会含在途的 A,A 失败回滚时 B 已把 A 设进 adapter;
    // 成功响应乱序时旧快照事件还会覆盖新断点。串行化后集合与快照天然有序。
    return runSerialPerKey(this.breakpointChains, `${sessionId}\0${sourceKey(realFile)}`, () =>
      this.setBreakpointsSerial(sessionId, input, realFile),
    );
  }

  private async setBreakpointsSerial(
    sessionId: string,
    input: SetBreakpointInput,
    realFile: string,
  ): Promise<{ verified: boolean; line?: number; message?: string }> {
    // 排队期间 session 可能已拆除。
    const runtime = this.requireRuntime(sessionId);
    // 追加到该 source 的断点集合(同 file+line 替换,不重复);此前整表替换成 [input],同文件第二个断点
    // 会把第一个从 adapter 里删掉。
    const source = sourceKey(realFile);
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
      const liveClients = [
        runtime.parentClient,
        ...runtime.childClients.filter((child) => !runtime.endedChildren.has(child)),
      ];
      await Promise.allSettled(
        liveClients.map(async (client) =>
          rememberBreakpointReports(
            runtime,
            client,
            rolledBackRecords,
            await client.sendRequest(
              'setBreakpoints',
              rolledBack,
              Math.min(this.requestTimeoutMs, CHILD_BREAKPOINT_SYNC_TIMEOUT_MS),
            ),
          ),
        ),
      );
      throw err;
    }
    rememberBreakpointReports(runtime, runtime.parentClient, sourceBreakpoints, response);
    // 已建立的 child session 各自维护断点:只发给父连接的话,程序跑起来之后再设的断点不会生效
    //(child 只在创建时拿到当时的断点)。逐个同步;某个 child 已退出导致失败不影响其它。
    // 取快照(发送期间 childClients 可能增减)、跳过已结束的 child、并行发送并用较短的超时:某个 child
    // 不应答(已退出的 worker 等)不能把整个工具调用拖到 N × requestTimeoutMs。
    await Promise.allSettled(
      runtime.childClients
        .filter((child) => !runtime.endedChildren.has(child))
        .map(async (child) =>
          rememberBreakpointReports(
            runtime,
            child,
            sourceBreakpoints,
            await child.sendRequest(
              'setBreakpoints',
              args,
              Math.min(this.requestTimeoutMs, CHILD_BREAKPOINT_SYNC_TIMEOUT_MS),
            ),
          ),
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
    this.emitSessionEvent(sessionId, {
      type: 'breakpoints-changed',
      sessionId,
      file: sourcePath,
      breakpoints: snapshot,
    });
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
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
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
    input: WaitForStopInput = {},
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

    const timeoutMs = input.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const waiter: StopWaiter = {
        afterStopSeq,
        resolve,
        reject,
        timer: setTimeout(() => {
          runtime.waiters.delete(waiter);
          reject(new Error(`debug wait_for_stop timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      runtime.waiters.add(waiter);
      // 等停点 = 要求程序在跑:没设断点就直接 wait_for_stop(如 stop_on_entry)时,程序此前从未起跑,会干等到
      // 超时。先同步登记 waiter 再起跑:登记之后的 teardown 照常结算它。起跑失败则摘掉 waiter 并以该错误 reject。
      this.ensureProgramStarted(runtime).catch((err: unknown) => {
        if (!runtime.waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  // thread_id 解析。js-debug 的 Node 线程 id 是 0(合法,DAP threadId 允许 0),
  // 所以 provided 给定就直接透传(含 0);省略时发 DAP threads 请求取首个线程。
  // DAP next/stepIn/stepOut/continue/stackTrace 都需要 threadId,故统一在此解析。
  private async resolveThreadId(
    sessionId: string,
    provided?: number,
  ): Promise<number> {
    if (provided !== undefined) return provided;
    // 优先用最近 stopped 事件记录的线程:多线程(worker)下这才是真正停住的那条,
    // 也省掉一次 threads 往返。0 是 Node 主线程的合法 id。
    const stopped = debugSessions.get(sessionId)?.currentThreadId;
    if (stopped !== undefined) return stopped;
    // 回退:无停点记录(如停点事件未带 threadId)→ threads 请求取首个线程。
    const runtime = this.requireRuntime(sessionId);
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
    input: { readonly threadId?: number } = {},
  ): Promise<{ continued: boolean; all_threads_continued?: boolean }> {
    return this.resume(sessionId, 'continue', input);
  }

  async stepOver(sessionId: string, input: { readonly threadId?: number } = {}) {
    return this.resume(sessionId, 'next', input);
  }

  async stepIn(sessionId: string, input: { readonly threadId?: number } = {}) {
    return this.resume(sessionId, 'stepIn', input);
  }

  async stepOut(sessionId: string, input: { readonly threadId?: number } = {}) {
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
        levels: input.levels ?? 20,
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
    },
  ): Promise<{
    readonly variables: readonly DebugVariable[];
    readonly truncated: boolean;
    readonly next_start?: number;
  }> {
    const runtime = this.requireRuntime(sessionId);
    const start = input.start ?? 0;
    const count = input.count ?? 100;
    const maxDepth = input.maxDepth ?? 1;
    const maxStringBytes = input.maxStringBytes ?? 65536;
    const variables = await this.readVariables(
      runtime,
      input.variablesReference,
      start,
      count,
      maxDepth,
      maxStringBytes,
    );
    // 本页取满 count 条 = 可能还有更多:truncated 与 next_start 同步(此前 truncated 写死 false)。
    const hasMore = variables.length >= count;
    return {
      variables,
      truncated: hasMore,
      ...(hasMore ? { next_start: start + count } : {}),
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
      input.maxResultBytes ?? 65536,
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
    return debugSessions.list().map((session) => ({
      session_id: session.id,
      state: session.runtimeState,
      ...(session.name !== undefined ? { name: session.name } : {}),
      ...(session.stoppedReason !== undefined
        ? { stopped_reason: session.stoppedReason }
        : {}),
      owner_window_id: session.ownerWindowId,
    }));
  }

  async cleanupAll(reason = 'cleanupAll'): Promise<readonly string[]> {
    return this.teardownMany(debugSessions.list(), reason);
  }

  async killByOwner(
    ownerWindowId: number,
    reason = 'killByOwner',
  ): Promise<readonly string[]> {
    return this.teardownMany(debugSessions.byOwner(ownerWindowId), reason);
  }

  async killByController(
    controllerToken: string,
    reason = 'killByController',
  ): Promise<readonly string[]> {
    return this.teardownMany(debugSessions.byController(controllerToken), reason);
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
    runtime.parentClient.sendRequestNoWait('launch', this.launchArguments(runtime));
    runtime.launched = true;
    // 已结束 / 拆除中的会话不翻回 running(configurationDone 期间可能已 teardown)。
    if (runtime.endedMessage === undefined && debugSessions.get(runtime.id)?.runtimeState === 'starting') {
      debugSessions.update(runtime.id, { runtimeState: 'running', runSeq: 1 });
    }
  }

  private launchArguments(runtime: RuntimeDebugSession): DapJson {
    const launch = runtime.launch;
    const cwd = launch.cwd ?? process.cwd();
    return {
      type: 'pwa-node',
      request: 'launch',
      name: launch.name ?? 'Continuo debug session',
      program: launch.program,
      cwd,
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
      // 每个 source 发一次完整集合(逐个断点发会让后一个覆盖前一个)。
      for (const [source, records] of breakpointsBySource(runtime.breakpoints)) {
        rememberBreakpointReports(
          runtime,
          child,
          records,
          await child.sendRequest(
            'setBreakpoints',
            setBreakpointsArgs(runtime.adapterPaths.get(source) ?? source, records),
            this.requestTimeoutMs,
          ),
        );
      }
      await child.sendRequest('configurationDone', {}, this.requestTimeoutMs);
    } catch (err) {
      // child 没建起来:摘掉它,activeClient 保持原样(父 client 仍可用)。若在连接前就切过去,
      // 后续 stack / variables / continue 会全部打到一个死 client 上。
      const index = runtime.childClients.indexOf(child);
      if (index >= 0) runtime.childClients.splice(index, 1);
      debugSessions.update(sessionId, { childSessionCount: runtime.childClients.length });
      await child.dispose().catch(() => undefined);
      // 摘除后重新判定:若其余 child 在这次握手期间都已结束,存活的 child 已全部结束 → 整个会话结束
      //(否则要等父 client 的 terminated 才收敛)。
      if (runtime.endedMessage === undefined && this.allChildrenEnded(runtime)) {
        this.endWholeSession(sessionId, runtime, 'debug session terminated');
      }
      throw err;
    }
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
      if (pid !== undefined) debugSessions.addSystemProcessId(sessionId, pid);
    });
    client.on('stopped', (event) => this.markStopped(sessionId, event.body, client));
    client.on('continued', () => this.markContinued(sessionId, client));
    client.on('breakpoint', (event) => this.handleBreakpointEvent(sessionId, client, event.body));
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
      runtime.endedChildren.add(client);
      if (!this.allChildrenEnded(runtime)) {
        this.dropEndedChildStops(sessionId, runtime, client);
        // 它的回报不再参与聚合:红点回落到其余连接的回报。
        this.emitSnapshotsReportedBy(sessionId, runtime, client);
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
      runtime.activeClient =
        runtime.childClients.find((child) => !runtime.endedChildren.has(child)) ??
        runtime.parentClient;
    }
  }

  private allChildrenEnded(runtime: RuntimeDebugSession): boolean {
    return (
      runtime.childClients.length > 0 &&
      runtime.childClients.every((child) => runtime.endedChildren.has(child))
    );
  }

  private endWholeSession(sessionId: string, runtime: RuntimeDebugSession, message: string): void {
    this.rejectWaiters(sessionId, new Error(message));
    runtime.endedMessage = message;
    debugSessions.update(sessionId, { runtimeState: 'terminated' });
  }

  private markStopped(
    sessionId: string,
    bodyJson: DapJson | undefined,
    client: DebugDapClientLike,
  ): void {
    const stoppedRuntime = this.runtimes.get(sessionId);
    if (stoppedRuntime?.endedMessage !== undefined) return; // 已结束:迟到事件不翻回状态
    if (stoppedRuntime) {
      // 排队与否都先记下命中:绑定是既成事实。
      this.markHitBreakpointsVerified(sessionId, stoppedRuntime, client, bodyJson);
      // 当前停点还没恢复、而这次停在另一条连接上 → 排队(同一连接的旧排队项被替换),稍后再呈现。
      if (
        stoppedRuntime.currentStop !== undefined &&
        stoppedRuntime.stoppedClient !== undefined &&
        stoppedRuntime.stoppedClient !== client
      ) {
        const queued = stoppedRuntime.queuedStops;
        const index = queued.findIndex((entry) => entry.client === client);
        if (index >= 0) queued.splice(index, 1);
        queued.push({ client, body: bodyJson });
        return;
      }
      // 停在哪条连接上,后续的 stack / scopes / variables / continue 就发给哪条连接(主线程或某个 worker)。
      stoppedRuntime.activeClient = client;
      stoppedRuntime.stoppedClient = client;
    }
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
    const runtime = this.requireRuntime(sessionId);
    runtime.currentStop = output;
    debugSessions.update(sessionId, {
      runtimeState: 'stopped',
      stopSeq,
      pausedEpoch: session.pausedEpoch + 1,
      ...(output.thread_id !== undefined ? { currentThreadId: output.thread_id } : {}),
      stoppedReason: output.reason,
    });
    this.emitSessionEvent(sessionId, {
      type: 'stopped',
      sessionId,
      stopSeq,
      reason: output.reason,
      ...(output.thread_id !== undefined ? { threadId: output.thread_id } : {}),
      ...(output.description !== undefined
        ? { description: output.description }
        : {}),
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
    debugSessions.update(sessionId, {
      runtimeState: 'running',
      runSeq: session.runSeq + 1,
      currentThreadId: undefined,
      stoppedReason: undefined,
    });
    this.emitSessionEvent(sessionId, {
      type: 'continued',
      sessionId,
      runSeq: session.runSeq + 1,
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
  ): Promise<readonly DebugVariable[]> {
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
    for (const raw of asArray(body.variables)) {
      const variable = asRecord(raw as DapJson);
      const rawValue = stringField(variable, 'value') ?? '';
      const truncated = truncateUtf8(rawValue, maxStringBytes);
      const childRef = numberField(variable, 'variablesReference') ?? 0;
      let children: readonly DebugVariable[] | undefined;
      if (maxDepth > 1 && childRef > 0) {
        children = await this.readVariables(
          runtime,
          childRef,
          0,
          count,
          maxDepth - 1,
          maxStringBytes,
        );
      }
      variables.push({
        name: stringField(variable, 'name') ?? '',
        value: truncated.value,
        ...(stringField(variable, 'type') !== undefined
          ? { type: stringField(variable, 'type') }
          : {}),
        ...(childRef > 0 ? { variables_reference: childRef } : {}),
        ...(truncated.truncated ? { truncated: true } : {}),
        ...(children !== undefined ? { children } : {}),
      });
    }
    return variables;
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
      debugSessions.markDone(sessionId);
      this.emitSessionEvent(sessionId, {
        type: 'terminated',
        sessionId,
        reason,
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
    for (const client of clients) {
      try {
        await client.sendRequest(
          'disconnect',
          { terminateDebuggee: true, restart: false },
          2_000,
        );
      } catch (err) {
        // DAP adapters often stop replying while the debuggee is already exiting.
        // Lifecycle cleanup is judged by the process-group/tree kill below.
        void err;
      }
    }

    try {
      const adapterInfo =
        session.adapterPgid !== undefined
          ? null
          : await this.processOps.processInfo(session.adapterPid);
      const pgid = session.adapterPgid ?? adapterInfo?.pgid ?? session.adapterPid;
      if (pgid) {
        debugSessions.update(sessionId, { adapterPgid: pgid });
        const groupBefore = await this.processOps.pidsInProcessGroup(pgid);
        const watchedPids = Array.from(
          new Set(
            [
              session.adapterPid,
              ...session.systemProcessIds,
              ...groupBefore.map((entry) => entry.pid),
            ].filter((pid): pid is number => typeof pid === 'number' && pid > 0),
          ),
        );
        const alive = await this.processOps.terminateProcessGroup(
          pgid,
          watchedPids,
          reason,
        );
        if (alive.length > 0) {
          throw new Error(`debug teardown left alive pids: ${alive.join(',')}`);
        }
      }
    } catch (err) {
      firstError ??= err instanceof Error ? err : new Error(String(err));
    }

    try {
      await runtime.parentClient.dispose();
    } catch (err) {
      firstError ??= err instanceof Error ? err : new Error(String(err));
    }
    if (firstError) throw firstError;
  }

  private requireRuntime(sessionId: string): RuntimeDebugSession {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error(`debug session not found: ${sessionId}`);
    return runtime;
  }

  private requireSession(sessionId: string): debugSessions.DebugSession {
    const session = debugSessions.get(sessionId);
    if (!session) throw new Error(`debug session not found: ${sessionId}`);
    return session;
  }
}
