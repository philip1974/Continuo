import { execFile as execFileCb } from 'node:child_process';
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

export interface DebugServiceOptions {
  readonly adapterPath?: string;
  readonly requestTimeoutMs?: number;
  readonly createDapClient?: (options: {
    adapterPath: string;
    requestTimeoutMs: number;
  }) => DebugDapClientLike;
  readonly processOps?: DebugProcessOps;
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

export interface DebugStackFrame {
  readonly id: number;
  readonly name: string;
  readonly source_path?: string;
  readonly line: number;
  readonly column?: number;
}

export interface DebugScope {
  readonly name: string;
  readonly variables_reference: number;
  readonly expensive: boolean;
}

export interface DebugVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly variables_reference?: number;
  readonly truncated?: boolean;
  readonly children?: readonly DebugVariable[];
}

interface StopWaiter {
  readonly afterStopSeq: number;
  readonly resolve: (value: WaitForStopOutput) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface BreakpointRecord {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
}

interface RuntimeDebugSession {
  readonly id: string;
  readonly parentClient: DebugDapClientLike;
  activeClient: DebugDapClientLike;
  readonly childClients: DebugDapClientLike[];
  readonly launch: LaunchSessionInput;
  readonly waiters: Set<StopWaiter>;
  readonly breakpoints: BreakpointRecord[];
  initialized: boolean;
  configurationDone: boolean;
  launched: boolean;
  currentStop?: WaitForStopOutput;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asRecord(value: DapJson | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function getClientPid(client: DebugDapClientLike): number | undefined {
  if (typeof client.serverPid === 'number') return client.serverPid;
  const maybe = client as unknown as { server?: { pid?: number } };
  return maybe.server?.pid;
}

function getSocketPath(client: DebugDapClientLike): string | undefined {
  return typeof client.socketPath === 'string' ? client.socketPath : undefined;
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
  private readonly runtimes = new Map<string, RuntimeDebugSession>();
  private readonly teardownInFlight = new Map<string, Promise<void>>();

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
  }

  async launchSession(
    input: LaunchSessionInput,
    ctx: DebugCallerContext,
  ): Promise<{ session_id: string; state: 'starting' | 'running' | 'stopped' }> {
    const id = makeSessionId();
    const parentClient = this.createDapClient({
      adapterPath: this.resolveAdapterPathLazy(),
      requestTimeoutMs: this.requestTimeoutMs,
    });

    await parentClient.spawnServer();
    const adapterPid = getClientPid(parentClient);
    const adapterInfo = await this.processOps.processInfo(adapterPid);
    const runtime: RuntimeDebugSession = {
      id,
      parentClient,
      activeClient: parentClient,
      childClients: [],
      launch: input,
      waiters: new Set(),
      breakpoints: [],
      initialized: false,
      configurationDone: false,
      launched: false,
    };
    this.runtimes.set(id, runtime);
    debugSessions.add({
      id,
      ownerWindowId: ctx.ownerWindowId,
      controllerToken: ctx.controllerToken,
      program: input.program,
      cwd: input.cwd ?? process.cwd(),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(adapterPid !== undefined ? { adapterPid } : {}),
      ...(getSocketPath(parentClient) !== undefined
        ? { socketPath: getSocketPath(parentClient) }
        : {}),
    });
    if (adapterInfo) debugSessions.update(id, { adapterPgid: adapterInfo.pgid });
    this.wireClient(id, parentClient);
    parentClient.setStartDebuggingHandler((request) =>
      this.handleStartDebugging(id, request),
    );

    const initialized = parentClient.waitForEvent(
      'initialized',
      this.requestTimeoutMs,
    );
    await parentClient.sendRequest('initialize', initializeArgs(), this.requestTimeoutMs);
    await initialized;
    runtime.initialized = true;
    debugSessions.update(id, { runtimeState: 'running' });
    return { session_id: id, state: 'running' };
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
    const runtime = this.requireRuntime(sessionId);
    runtime.breakpoints.splice(0, runtime.breakpoints.length, input);
    const response = await runtime.parentClient.sendRequest(
      'setBreakpoints',
      {
        source: { path: input.file },
        breakpoints: [
          {
            line: input.line,
            ...(input.column !== undefined ? { column: input.column } : {}),
          },
        ],
        sourceModified: false,
      },
      this.requestTimeoutMs,
    );
    await this.ensureConfigurationDone(runtime);
    await this.ensureLaunchStarted(runtime);
    const body = asRecord(response.body);
    const breakpoint = asRecord(asArray(body.breakpoints)[0] as DapJson | undefined);
    return {
      verified: boolField(breakpoint, 'verified') ?? true,
      ...(numberField(breakpoint, 'line') !== undefined
        ? { line: numberField(breakpoint, 'line') }
        : {}),
      ...(stringField(breakpoint, 'message') !== undefined
        ? { message: stringField(breakpoint, 'message') }
        : {}),
    };
  }

  waitForStop(
    sessionId: string,
    input: WaitForStopInput = {},
  ): Promise<WaitForStopOutput> {
    const runtime = this.requireRuntime(sessionId);
    const session = this.requireSession(sessionId);
    const afterStopSeq = input.afterStopSeq ?? 0;
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
    });
  }

  async continue(
    sessionId: string,
    input: { readonly threadId?: number } = {},
  ): Promise<{ continued: boolean; all_threads_continued?: boolean }> {
    const runtime = this.requireRuntime(sessionId);
    const response = await runtime.activeClient.sendRequest(
      'continue',
      {
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
      this.requestTimeoutMs,
    );
    this.markContinued(sessionId, response.body);
    const body = asRecord(response.body);
    return {
      continued: boolField(body, 'allThreadsContinued') ?? true,
      ...(boolField(body, 'allThreadsContinued') !== undefined
        ? { all_threads_continued: boolField(body, 'allThreadsContinued') }
        : {}),
    };
  }

  async stepOver(sessionId: string, input: { readonly threadId?: number } = {}) {
    return this.step(sessionId, 'next', input);
  }

  async stepIn(sessionId: string, input: { readonly threadId?: number } = {}) {
    return this.step(sessionId, 'stepIn', input);
  }

  async stepOut(sessionId: string, input: { readonly threadId?: number } = {}) {
    return this.step(sessionId, 'stepOut', input);
  }

  async stackTrace(
    sessionId: string,
    input: { readonly threadId: number; readonly startFrame?: number; readonly levels?: number },
  ): Promise<{ frames: readonly DebugStackFrame[]; total_frames?: number }> {
    const runtime = this.requireRuntime(sessionId);
    const response = await runtime.activeClient.sendRequest(
      'stackTrace',
      {
        threadId: input.threadId,
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
    if (frames[0]) debugSessions.update(sessionId, { currentFrameId: frames[0].id });
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
    debugSessions.addScopeRefs(
      sessionId,
      scopes.map((scope) => scope.variables_reference),
    );
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
    return {
      variables,
      truncated: false,
      ...(variables.length >= count ? { next_start: start + count } : {}),
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

  async disconnect(
    sessionId: string,
    input: { readonly terminateDebuggee?: boolean } = {},
  ): Promise<{ disconnected: boolean }> {
    await this.teardownSession(
      sessionId,
      input.terminateDebuggee === false ? 'disconnect' : 'disconnect terminate',
    );
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

  private async step(
    sessionId: string,
    command: 'next' | 'stepIn' | 'stepOut',
    input: { readonly threadId?: number },
  ) {
    const runtime = this.requireRuntime(sessionId);
    const response = await runtime.activeClient.sendRequest(
      command,
      {
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
      this.requestTimeoutMs,
    );
    this.markContinued(sessionId, response.body);
    const body = asRecord(response.body);
    return {
      continued: boolField(body, 'allThreadsContinued') ?? true,
      ...(boolField(body, 'allThreadsContinued') !== undefined
        ? { all_threads_continued: boolField(body, 'allThreadsContinued') }
        : {}),
    };
  }

  private async ensureConfigurationDone(runtime: RuntimeDebugSession): Promise<void> {
    if (runtime.configurationDone) return;
    await runtime.parentClient.sendRequest(
      'configurationDone',
      {},
      this.requestTimeoutMs,
    );
    runtime.configurationDone = true;
  }

  private async ensureLaunchStarted(runtime: RuntimeDebugSession): Promise<void> {
    if (runtime.launched) return;
    runtime.parentClient.sendRequestNoWait('launch', this.launchArguments(runtime));
    runtime.launched = true;
    debugSessions.update(runtime.id, { runtimeState: 'running', runSeq: 1 });
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

  private async handleStartDebugging(
    sessionId: string,
    request: DapRequestMessage,
  ): Promise<DapJson> {
    const runtime = this.requireRuntime(sessionId);
    const child = runtime.parentClient.createChildSession();
    runtime.childClients.push(child);
    runtime.activeClient = child;
    debugSessions.update(sessionId, {
      childSessionCount: runtime.childClients.length,
    });
    this.wireClient(sessionId, child);
    await child.connectToServer();

    const initialized = child.waitForEvent('initialized', this.requestTimeoutMs);
    await child.sendRequest('initialize', initializeArgs(), this.requestTimeoutMs);
    await initialized;
    for (const breakpoint of runtime.breakpoints) {
      await child.sendRequest(
        'setBreakpoints',
        {
          source: { path: breakpoint.file },
          breakpoints: [
            {
              line: breakpoint.line,
              ...(breakpoint.column !== undefined
                ? { column: breakpoint.column }
                : {}),
            },
          ],
          sourceModified: false,
        },
        this.requestTimeoutMs,
      );
    }
    await child.sendRequest('configurationDone', {}, this.requestTimeoutMs);

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
    client.on('stopped', (event) => this.markStopped(sessionId, event.body));
    client.on('continued', (event) => this.markContinued(sessionId, event.body));
    client.on('terminated', () =>
      this.rejectWaiters(sessionId, new Error('debug session terminated')),
    );
    client.on('exited', () =>
      this.rejectWaiters(sessionId, new Error('debug session exited')),
    );
  }

  private markStopped(sessionId: string, bodyJson: DapJson | undefined): void {
    const body = asRecord(bodyJson);
    const session = this.requireSession(sessionId);
    const stopSeq = session.stopSeq + 1;
    const output: WaitForStopOutput = {
      session_id: sessionId,
      stop_seq: stopSeq,
      reason: stringField(body, 'reason') ?? 'stopped',
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

    for (const waiter of Array.from(runtime.waiters)) {
      if (stopSeq <= waiter.afterStopSeq) continue;
      clearTimeout(waiter.timer);
      runtime.waiters.delete(waiter);
      waiter.resolve(output);
    }
  }

  private markContinued(sessionId: string, _bodyJson: DapJson | undefined): void {
    const session = this.requireSession(sessionId);
    const runtime = this.requireRuntime(sessionId);
    if (session.runtimeState === 'running' && runtime.currentStop === undefined) {
      return;
    }
    runtime.currentStop = undefined;
    debugSessions.update(sessionId, {
      runtimeState: 'running',
      runSeq: session.runSeq + 1,
      currentThreadId: undefined,
      currentFrameId: undefined,
      scopeRefs: [],
      stoppedReason: undefined,
    });
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
