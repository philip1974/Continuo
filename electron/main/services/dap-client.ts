import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, promises as fs } from 'node:fs';
import { type Readable } from 'node:stream';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

type DapPrimitive = string | number | boolean | null;
export type DapJson =
  | DapPrimitive
  | readonly DapJson[]
  | { readonly [key: string]: DapJson };

export interface DapProtocolMessage {
  readonly seq?: number;
  readonly type?: string;
  readonly [key: string]: DapJson | undefined;
}

export interface DapResponseMessage extends DapProtocolMessage {
  readonly type: 'response';
  readonly request_seq: number;
  readonly success?: boolean;
  readonly command?: string;
  readonly message?: string;
  readonly body?: DapJson;
}

export interface DapEventMessage extends DapProtocolMessage {
  readonly type: 'event';
  readonly event: string;
  readonly body?: DapJson;
}

export interface DapRequestMessage extends DapProtocolMessage {
  readonly type: 'request';
  readonly command: string;
  readonly arguments?: DapJson;
}

export type DapMessage =
  | DapRequestMessage
  | DapResponseMessage
  | DapEventMessage
  | DapProtocolMessage;

interface PendingRequest {
  readonly resolve: (response: DapResponseMessage) => void;
  readonly reject: (err: Error) => void;
}

export interface DapTranscriptEntry {
  readonly direction: 'client' | 'server' | 'server-stdout';
  readonly message?: DapMessage;
  readonly text?: string;
}

export type DapEventHandler = (event: DapEventMessage) => void;
export type StartDebuggingHandler = (
  request: DapRequestMessage,
  client: DapClient,
) => Promise<DapJson | undefined> | DapJson | undefined;

export interface DapClientOptions {
  readonly adapterPath?: string;
  readonly nodePath?: string;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly connectIntervalMs?: number;
  readonly socketPath?: string | null;
  readonly tcpPort?: number;
  readonly transcript?: DapTranscriptEntry[];
  readonly startDebuggingHandler?: StartDebuggingHandler | null;
  readonly traceId?: string;
}

export const defaultAdapterPath = path.join(
  process.cwd(),
  'scripts',
  'debug-spike',
  '.adapter',
  'js-debug',
  'src',
  'dapDebugServer.js',
);

export function encodeDapMessage(message: DapMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

export function parseDapContentLength(header: string): number {
  for (const line of header.split('\r\n')) {
    const match = /^Content-Length:\s*(\d+)$/i.exec(line);
    if (match) return Number.parseInt(match[1]!, 10);
  }
  throw new Error(`DAP frame missing Content-Length header: ${header}`);
}

export class DapStreamDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer | Uint8Array | string): DapMessage[] {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, input]);
    const messages: DapMessage[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return messages;

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const contentLength = parseDapContentLength(header);
      const bodyStart = headerEnd + 4;
      const frameEnd = bodyStart + contentLength;
      if (this.buffer.length < frameEnd) return messages;

      const body = this.buffer.subarray(bodyStart, frameEnd).toString('utf8');
      messages.push(JSON.parse(body) as DapMessage);
      this.buffer = this.buffer.subarray(frameEnd);
    }
  }
}

export const encodeMessage = encodeDapMessage;
export const StreamDecoder = DapStreamDecoder;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createSocketPath(): string | null {
  if (process.platform === 'win32') return null;
  const baseDir = os.tmpdir().length < 60 ? os.tmpdir() : '/tmp';
  const socketPath = path.join(
    baseDir,
    `continuo-dap-${process.pid}-${Date.now()}.sock`,
  );
  if (socketPath.length > 100) {
    return path.join('/tmp', `cdap-${process.pid}-${Date.now()}.sock`);
  }
  return socketPath;
}

function randomTcpPort(): number {
  return 20_000 + Math.floor(Math.random() * 30_000);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isDapResponse(message: DapMessage): message is DapResponseMessage {
  return message.type === 'response' && typeof message.request_seq === 'number';
}

function isDapEvent(message: DapMessage): message is DapEventMessage {
  return message.type === 'event' && typeof message.event === 'string';
}

function isDapRequest(message: DapMessage): message is DapRequestMessage {
  return message.type === 'request' && typeof message.command === 'string';
}

let dapTraceCounter = 0;
function nextDapTraceId(): string {
  dapTraceCounter += 1;
  return `dap${dapTraceCounter}`;
}

// dev-gated DAP transcript logger:设 CONTINUO_DEBUG_DAP_TRACE=<file> 时,把每条 DAP
// 收发落 JSONL(client 标识/方向/类型/seq/关键 body)。未设=零开销。永不抛错。
// 用途:定位 parent/child 多 session 下 stopped 事件的真实 reason 序列(#2)。
function traceDap(
  traceId: string,
  direction: 'send' | 'recv',
  message: DapMessage,
): void {
  const file = process.env.CONTINUO_DEBUG_DAP_TRACE;
  if (!file) return;
  try {
    const m = message as unknown as Record<string, unknown>;
    const entry = {
      t: Date.now(),
      client: traceId,
      dir: direction,
      type: m.type,
      ...(m.command !== undefined ? { command: m.command } : {}),
      ...(m.event !== undefined ? { event: m.event } : {}),
      ...(m.seq !== undefined ? { seq: m.seq } : {}),
      ...(m.request_seq !== undefined ? { request_seq: m.request_seq } : {}),
      ...(m.success !== undefined ? { success: m.success } : {}),
      // 事件给全 body(stopped 含 reason);请求给 arguments;响应略 body(避免 variables/stack 巨量)。
      ...(m.type === 'event' ? { body: m.body } : {}),
      ...(m.type === 'request' ? { arguments: m.arguments } : {}),
    };
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // tracing 绝不破坏调试
  }
}

export class DapClient {
  readonly adapterPath: string;
  readonly nodePath: string;
  readonly readyTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly connectIntervalMs: number;
  readonly socketPath: string | null;
  readonly tcpPort: number;
  readonly transcript: DapTranscriptEntry[];

  private server: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private socket: Socket | null = null;
  private seq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Map<string, Set<DapEventHandler>>();
  private decoder = new DapStreamDecoder();
  private serverStderr = '';
  private childSessions: DapClient[] = [];
  private startDebuggingHandler: StartDebuggingHandler | null;
  private disposed = false;
  private readonly traceId: string;

  constructor(options: DapClientOptions = {}) {
    this.adapterPath = options.adapterPath ?? defaultAdapterPath;
    this.nodePath = options.nodePath ?? process.execPath;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.connectIntervalMs = options.connectIntervalMs ?? 100;
    this.socketPath =
      options.socketPath === undefined ? createSocketPath() : options.socketPath;
    this.tcpPort = options.tcpPort ?? randomTcpPort();
    this.transcript = options.transcript ?? [];
    this.startDebuggingHandler = options.startDebuggingHandler ?? null;
    this.traceId = options.traceId ?? nextDapTraceId();
  }

  async spawnServer(): Promise<this> {
    const endpoint = this.socketPath ?? String(this.tcpPort);
    if (!endpoint) {
      throw new Error('no DAP endpoint configured');
    }
    if (this.socketPath) {
      await fs.rm(this.socketPath, { force: true });
    }

    // nodePath 默认 process.execPath。在打包/dev 的 Electron 里 process.execPath 是
    // Electron 二进制,必须设 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 跑 dapDebugServer.js;
    // 否则 Electron 会把脚本当成 app 入口加载 → "Dynamic require of fs is not supported"。
    // 同时按 safeguard 剥离敏感 env(不把 CONTINUO_MCP_TOKEN 泄漏给 adapter/debuggee)。
    const adapterEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    };
    delete adapterEnv.CONTINUO_MCP_TOKEN;
    const server = spawn(this.nodePath, [this.adapterPath, endpoint], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: adapterEnv,
    });
    this.server = server;
    server.stderr.on('data', (chunk: Buffer) => {
      this.serverStderr += chunk.toString('utf8');
    });
    server.stdout.on('data', (chunk: Buffer) => {
      this.transcript.push({
        direction: 'server-stdout',
        text: chunk.toString('utf8'),
      });
    });
    server.once('exit', (code, signal) => {
      this.rejectAllPending(
        new Error(`DAP server exited code=${code} signal=${signal}`),
      );
    });

    this.socket = await this.waitForReady();
    this.attachSocket(this.socket);
    return this;
  }

  async connectToServer(): Promise<this> {
    this.socket = await this.connectOnce();
    this.attachSocket(this.socket);
    return this;
  }

  createChildSession(options: DapClientOptions = {}): DapClient {
    const child = new DapClient({
      adapterPath: this.adapterPath,
      nodePath: this.nodePath,
      readyTimeoutMs: this.readyTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
      connectIntervalMs: this.connectIntervalMs,
      socketPath: this.socketPath,
      tcpPort: this.tcpPort,
      transcript: this.transcript,
      traceId: `${this.traceId}>child${this.childSessions.length}`,
      ...options,
    });
    this.childSessions.push(child);
    return child;
  }

  setStartDebuggingHandler(handler: StartDebuggingHandler | null): void {
    this.startDebuggingHandler = handler;
  }

  async waitForReady(): Promise<Socket> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      try {
        return await this.connectOnce();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await sleep(this.connectIntervalMs);
      }
    }

    const detail = lastError ? ` last error: ${lastError.message}` : '';
    throw new Error(
      `DAP server readiness timed out after ${this.readyTimeoutMs}ms.${detail}\n` +
        `server stderr:\n${this.serverStderr}`,
    );
  }

  connectOnce(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.socketPath
        ? net.connect(this.socketPath)
        : net.connect({ port: this.tcpPort, host: '127.0.0.1' });
      socket.once('connect', () => resolve(socket));
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  attachSocket(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) {
        this.receiveMessage(message);
      }
    });
    socket.on('error', (err) => this.rejectAllPending(err));
    socket.on('close', () => {
      this.rejectAllPending(new Error('DAP socket closed'));
    });
  }

  on(eventName: string, callback: DapEventHandler): () => void {
    const callbacks = this.eventHandlers.get(eventName) ?? new Set<DapEventHandler>();
    callbacks.add(callback);
    this.eventHandlers.set(eventName, callbacks);
    return () => callbacks.delete(callback);
  }

  waitForEvent(
    eventName: string,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<DapEventMessage> {
    return withTimeout(
      new Promise((resolve) => {
        const off = this.on(eventName, (event) => {
          off();
          resolve(event);
        });
      }),
      timeoutMs,
      `event ${eventName}`,
    );
  }

  sendRequest(
    command: string,
    args: DapJson = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<DapResponseMessage> {
    const request = this.createRequest(command, args);
    const response = withTimeout(
      new Promise<DapResponseMessage>((resolve, reject) => {
        this.pending.set(request.seq, { resolve, reject });
      }),
      timeoutMs,
      `request ${command}`,
    );
    this.sendMessage(request);
    return response;
  }

  sendRequestNoWait(command: string, args: DapJson = {}): number {
    const request = this.createRequest(command, args);
    this.sendMessage(request);
    return request.seq;
  }

  createRequest(command: string, args: DapJson): DapRequestMessage & { seq: number } {
    return {
      seq: this.seq++,
      type: 'request',
      command,
      arguments: args,
    };
  }

  sendMessage(message: DapMessage): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('DAP socket is not connected');
    }
    this.transcript.push({ direction: 'client', message });
    traceDap(this.traceId, 'send', message);
    this.socket.write(encodeDapMessage(message));
  }

  receiveMessage(message: DapMessage): void {
    this.transcript.push({ direction: 'server', message });
    traceDap(this.traceId, 'recv', message);
    if (isDapResponse(message)) {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      if (message.success === false) {
        pending.reject(
          new Error(message.message ?? `DAP request ${message.request_seq} failed`),
        );
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (isDapEvent(message)) {
      const callbacks = this.eventHandlers.get(message.event);
      if (!callbacks) return;
      for (const callback of callbacks) callback(message);
      return;
    }

    if (isDapRequest(message)) {
      void this.respondToReverseRequest(message);
    }
  }

  async respondToReverseRequest(message: DapRequestMessage): Promise<void> {
    if (message.command === 'startDebugging' && this.startDebuggingHandler) {
      try {
        const body = await this.startDebuggingHandler(message, this);
        this.sendMessage({
          seq: this.seq++,
          type: 'response',
          request_seq: message.seq ?? 0,
          command: message.command,
          success: true,
          body: body ?? {},
        });
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        this.sendMessage({
          seq: this.seq++,
          type: 'response',
          request_seq: message.seq ?? 0,
          command: message.command,
          success: false,
          message: messageText,
        });
      }
      return;
    }

    const unsupported = message.command !== 'runInTerminal';
    this.sendMessage({
      seq: this.seq++,
      type: 'response',
      request_seq: message.seq ?? 0,
      command: message.command,
      success: !unsupported,
      message: unsupported
        ? `unsupported reverse request: ${message.command}`
        : undefined,
      body: unsupported ? undefined : {},
    });
  }

  rejectAllPending(err: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    await Promise.all(
      this.childSessions.map((child) => child.dispose().catch(() => undefined)),
    );
    this.childSessions = [];
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    await this.killServer();
    if (this.socketPath) {
      await fs.rm(this.socketPath, { force: true });
    }
  }

  async kill(): Promise<void> {
    await this.dispose();
  }

  private async killServer(): Promise<void> {
    if (
      !this.server ||
      this.server.exitCode !== null ||
      this.server.signalCode !== null
    ) {
      return;
    }
    this.server.kill('SIGTERM');
    const exited = Promise.race([
      once(this.server, 'exit'),
      sleep(1_000).then(() => 'timeout' as const),
    ]);
    if ((await exited) === 'timeout') {
      this.server.kill('SIGKILL');
    }
  }
}
