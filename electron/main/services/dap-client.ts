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

/**
 * 内存 transcript(诊断用)保留的最大条目数。此前无上限:每条收发的 DAP 消息(含 variables 等大 payload)
 * 都留到 session 结束,长调试会话内存单调增长。
 */
export const DAP_TRANSCRIPT_MAX_ENTRIES = 1000;

/**
 * 单条 transcript 的字节上限(UTF-8 字节)。只按条数封顶时单帧可达 DAP_MAX_FRAME_BYTES(64MiB),
 * 反复 evaluate 大字符串会留住 GB 级数据;服务层返回值本就截断到 64KiB,诊断只需定位字段,超限只存摘要。
 * 计量口径(契约):入站消息按**线上字节**(帧头 Content-Length)计,出站按本端成帧的那次序列化计,
 * 不对入站对象重新规范化序列化。对端发非紧凑 JSON(大量空白 / \uXXXX 转义)时,线上超限即只存摘要,
 * 即使规范化后小于上限;摘要的 originalBytes 也是线上字节数。
 */
export const DAP_TRANSCRIPT_ENTRY_MAX_BYTES = 8 * 1024;

/** 一份 transcript(父子 session 共享)的总字节预算,超出淘汰最旧的条目。 */
export const DAP_TRANSCRIPT_MAX_BYTES = 1024 * 1024;

export interface DapTranscriptEntry {
  readonly direction: 'client' | 'server' | 'server-stdout';
  readonly message?: DapMessage;
  readonly text?: string;
}

/** 各份 transcript 当前占用的字节数(数组由父子 session 共享,计数随数组走)。 */
const transcriptBytes = new WeakMap<DapTranscriptEntry[], number>();
/** 每条 transcript 入账时的字节数(淘汰时扣回)。 */
const transcriptEntryBytes = new WeakMap<DapTranscriptEntry, number>();

/** 超过单条上限的消息只留定位字段(seq / type / command / event / request_seq / success)与原始大小。 */
function transcriptSummary(message: DapMessage, originalBytes: number): DapMessage {
  const summary: Record<string, DapJson> = { transcriptTruncated: true, originalBytes };
  for (const key of ['seq', 'type', 'command', 'event', 'request_seq', 'success'] as const) {
    const value = message[key];
    if (value !== undefined) summary[key] = value;
  }
  return summary as DapMessage;
}

/**
 * 按单条字节上限截断(必要时换成摘要),返回入账的条目及其字节数。
 * messageBytes:调用方已知的消息字节数(入站 = 帧头 Content-Length 即线上字节,出站 = 成帧用的那次序列化),
 * 给出时不再为计量 JSON.stringify 一遍 —— 大响应(最大 8MiB)再序列化只为发现超限后丢弃,白占主线程。
 */
function boundTranscriptEntry(
  entry: DapTranscriptEntry,
  messageBytes?: number,
): {
  entry: DapTranscriptEntry;
  bytes: number;
} {
  if (entry.message !== undefined) {
    const bytes = messageBytes ?? Buffer.byteLength(JSON.stringify(entry.message), 'utf8');
    if (bytes <= DAP_TRANSCRIPT_ENTRY_MAX_BYTES) return { entry, bytes };
    const message = transcriptSummary(entry.message, bytes);
    return {
      entry: { direction: entry.direction, message },
      bytes: Buffer.byteLength(JSON.stringify(message), 'utf8'),
    };
  }
  const text = Buffer.from(entry.text ?? '', 'utf8');
  if (text.length <= DAP_TRANSCRIPT_ENTRY_MAX_BYTES) return { entry, bytes: text.length };
  // 按字节截断(截在多字节字符中间时末尾解码为 U+FFFD,字节数以截后实际值入账)。
  const bounded = text.subarray(0, DAP_TRANSCRIPT_ENTRY_MAX_BYTES).toString('utf8');
  return {
    entry: { direction: entry.direction, text: bounded },
    bytes: Buffer.byteLength(bounded, 'utf8'),
  };
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
  return frameDapBody(Buffer.from(JSON.stringify(message), 'utf8'));
}

function frameDapBody(body: Buffer): Buffer {
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/** 解码出的一帧:bodyBytes 为帧体线上字节数(Content-Length);合成的超限失败响应没有对应帧体,为 undefined。 */
export interface DapDecodedFrame {
  readonly message: DapMessage;
  readonly bodyBytes?: number;
}

/**
 * 单个 DAP 帧 body 的字节上限。对端是本机 js-debug,正常响应远小于此;evaluate 结果服务层也只返回 64KiB,
 * 更大的帧收进来只会白占内存(evaluate('x'.repeat(16777216)) 曾把 RSS 冲到 ~1.1GiB)。超限帧不缓冲、边收边丢:
 * 能从帧体前缀认出是响应时合成失败响应只 reject 对应请求,否则(事件等)静默丢弃 —— 不断开整条会话。
 */
export const DAP_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** 超限帧保留用于识别 request_seq / command 的帧体前缀字节数(js-debug 响应的这两个字段在最前面)。 */
const DAP_OVERSIZED_PREFIX_BYTES = 1024;

/** 帧头(`Content-Length: N` 等)的字节上限。 */
const DAP_MAX_HEADER_BYTES = 64 * 1024;

function parseDapContentLength(header: string): number {
  for (const line of header.split('\r\n')) {
    const match = /^Content-Length:\s*(\d+)$/i.exec(line);
    if (!match) continue;
    return Number.parseInt(match[1]!, 10);
  }
  throw new Error(`DAP frame missing Content-Length header: ${header}`);
}

// 合法 framing 但顶层不是 `{ type: string, ... }`(null / 数组 / 字符串 / 数字)也算畸形帧:此前原样强转,
// 派发时读 null.type 抛 TypeError,而派发不在 try/catch 内 → 主进程未捕获异常。在解码阶段抛错,
// 走与「缺 Content-Length / 非 JSON」相同的路径(结算在途请求并断开连接)。
function parseDapMessageBody(body: string): DapMessage {
  const parsed: unknown = JSON.parse(body);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  ) {
    throw new Error('DAP message must be a JSON object with a string type');
  }
  return parsed as DapMessage;
}

/** 超限帧被丢弃时:前缀能认出是响应 → 合成失败响应(只 reject 对应请求);认不出 → undefined(静默丢弃)。 */
function oversizedFrameResponse(prefix: string, length: number): DapResponseMessage | undefined {
  if (!/"type"\s*:\s*"response"/.test(prefix)) return undefined;
  const requestSeq = /"request_seq"\s*:\s*(\d+)/.exec(prefix);
  if (!requestSeq) return undefined;
  const command = /"command"\s*:\s*"([^"\\]{1,64})"/.exec(prefix);
  return {
    seq: 0,
    type: 'response',
    request_seq: Number.parseInt(requestSeq[1]!, 10),
    ...(command ? { command: command[1]! } : {}),
    success: false,
    message: `DAP response of ${length} bytes exceeds ${DAP_MAX_FRAME_BYTES} bytes; dropped`,
  };
}

/**
 * 收包按 chunk 数组累积,只在凑够帧头声明的整帧时一次性拼接(找帧头只拼有界前缀):旧实现每个 chunk 都
 * Buffer.concat 整个缓冲,大帧分成 n 块收就是 O(n²) 复制。
 */
export class DapStreamDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  /** 已解析帧头、等待帧体的字节数;null = 正在找帧头。 */
  private bodyLength: number | null = null;
  /** 正在丢弃的超限帧:先收前缀用于识别,其余字节边收边丢。 */
  private oversized: { length: number; remaining: number; prefix: Buffer | null } | null = null;

  push(chunk: Buffer | Uint8Array | string): DapMessage[] {
    return this.pushFrames(chunk).map((frame) => frame.message);
  }

  pushFrames(chunk: Buffer | Uint8Array | string): DapDecodedFrame[] {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (input.length > 0) {
      this.chunks.push(input);
      this.buffered += input.length;
    }
    const messages: DapDecodedFrame[] = [];

    while (true) {
      if (this.oversized) {
        const over = this.oversized;
        if (over.prefix === null) {
          const prefixLength = Math.min(DAP_OVERSIZED_PREFIX_BYTES, over.remaining);
          if (this.buffered < prefixLength) return messages;
          over.prefix = this.take(prefixLength);
          over.remaining -= prefixLength;
        }
        over.remaining -= this.drop(over.remaining);
        if (over.remaining > 0) return messages;
        const response = oversizedFrameResponse(over.prefix.toString('utf8'), over.length);
        if (response) messages.push({ message: response });
        this.oversized = null;
        continue;
      }

      if (this.bodyLength === null) {
        const head = this.peek(Math.min(this.buffered, DAP_MAX_HEADER_BYTES + 4));
        const headerEnd = head.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          // 帧头迟迟不结束 = 畸形流:帧体上限管不到这里,缓冲会无界增长。
          if (this.buffered > DAP_MAX_HEADER_BYTES) {
            throw new Error(`DAP frame header exceeds ${DAP_MAX_HEADER_BYTES} bytes`);
          }
          return messages;
        }
        const contentLength = parseDapContentLength(head.subarray(0, headerEnd).toString('ascii'));
        this.drop(headerEnd + 4);
        if (contentLength > DAP_MAX_FRAME_BYTES) {
          this.oversized = { length: contentLength, remaining: contentLength, prefix: null };
          continue;
        }
        this.bodyLength = contentLength;
      }

      if (this.buffered < this.bodyLength) return messages;
      const bodyBytes = this.bodyLength;
      const body = this.take(bodyBytes).toString('utf8');
      this.bodyLength = null;
      messages.push({ message: parseDapMessageBody(body), bodyBytes });
    }
  }

  /** 前 n 字节(不消费);n 不超过已缓冲字节数。 */
  private peek(n: number): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= n) return first.subarray(0, n);
    return Buffer.concat(this.chunks, n);
  }

  /** 取出并消费前 n 字节;n 不超过已缓冲字节数。 */
  private take(n: number): Buffer {
    const out = this.peek(n);
    this.drop(n);
    return out;
  }

  /** 丢弃至多 n 字节,返回实际丢弃数。 */
  private drop(n: number): number {
    let dropped = 0;
    while (dropped < n && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const need = n - dropped;
      if (first.length <= need) {
        this.chunks.shift();
        dropped += first.length;
      } else {
        this.chunks[0] = first.subarray(need);
        dropped += need;
      }
    }
    this.buffered -= dropped;
    return dropped;
  }
}

const SERVER_STDERR_MAX_CHARS = 64 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// unix socket 路径上限 macOS 104 / Linux 108 字节(含结尾 NUL),留余量。
const SOCKET_PATH_MAX_BYTES = 100;
const SOCKET_DIR_PREFIX = 'cdap-';
const SOCKET_FILE_NAME = 'dap.sock';

/**
 * POSIX:在 os.tmpdir()(过长时回退 /tmp)下用 mkdtemp 建私有目录(0700),socket 放其中 —— 直接放 tmpdir /
 * 全局共享的 /tmp 时,本机其它用户能否连上 adapter 只取决于 umask。mkdtemp 的随机名同时保证并发 launch 各用
 * 各的路径(不串线)。同一用户的其它进程不在威胁模型内(它们本可直接以该用户身份执行代码),不做鉴权。
 */
async function createPrivateSocketDir(): Promise<string> {
  // mkdtemp 追加 6 个随机字符。
  const fits = (base: string): boolean =>
    Buffer.byteLength(path.join(base, `${SOCKET_DIR_PREFIX}XXXXXX`, SOCKET_FILE_NAME)) <= SOCKET_PATH_MAX_BYTES;
  const baseDir = fits(os.tmpdir()) ? os.tmpdir() : '/tmp';
  const dir = await fs.mkdtemp(path.join(baseDir, SOCKET_DIR_PREFIX));
  // mkdtemp 本身以 0700 创建,但仍受 umask 影响(umask 只会更严);显式 chmod 钉死权限。
  await fs.chmod(dir, 0o700);
  return dir;
}

/** TCP 模式下 adapter 监听与客户端连接共用的地址(两端必须一致)。 */
const DAP_TCP_HOST = '127.0.0.1';

function randomTcpPort(): number {
  return 20_000 + Math.floor(Math.random() * 30_000);
}

/** 随机端口被占(adapter 就绪前退出)时,换端口重新 spawn 的总尝试次数。 */
const TCP_SPAWN_ATTEMPTS = 3;

/** js-debug dapDebugServer.js 在端口上 listen 成功后打到 stdout 的就绪行前缀。 */
const ADAPTER_LISTENING_MARK = 'Debug server listening at';

/** 单次 spawn 的 adapter 状态(重试时换一份,旧进程的迟到事件不会污染新一次)。 */
interface AdapterRunState {
  /** 已退出时的原因描述(code / signal)。 */
  exited: string | null;
  /** stdio 关闭(退出后 stderr 已读完)。 */
  closed: Promise<void>;
  /** stdout 已出现就绪行:端口确由本 adapter 监听。 */
  listening: boolean;
  /** 找就绪行用的 stdout 开头(封顶)。 */
  stdoutHead: string;
}

class AdapterExitedEarlyError extends Error {}

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
  readonly transcript: DapTranscriptEntry[];

  private server: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private socket: Socket | null = null;
  private seq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Map<string, Set<DapEventHandler>>();
  private decoder = new DapStreamDecoder();
  private serverStderr = '';
  private spawnError: Error | null = null;
  private childSessions: DapClient[] = [];
  /** 子会话 traceId 序号(列表会随 child 单独 dispose 缩短,不能用长度编号)。 */
  private childSessionSeq = 0;
  /** 创建本 child 的 client:单独 dispose 时从它的 childSessions 摘除,否则反复建 / 结束 worker 时无界累积。 */
  private parentSession: DapClient | null = null;
  private startDebuggingHandler: StartDebuggingHandler | null;
  private disposed = false;
  /** disposeWhenIdle 的等待者:在途请求全部结算(响应 / 失败 / 超时)时唤醒。 */
  private idleWaiters: Array<() => void> = [];
  private readonly traceId: string;
  /** 未显式给 socketPath 时,spawnServer 在 POSIX 上自建私有目录(dispose 时连同 socket 删除)。 */
  private readonly autoSocketPath: boolean;
  /** 本 client 建的私有 socket 目录(只有它负责删除;child 共用父的路径,不持有)。 */
  private socketDir: string | null = null;
  private socketPathValue: string | null;
  private tcpPortValue: number;
  /** 端口是自己随机取的(未显式指定):冲突时才允许换端口重试。 */
  private readonly autoTcpPort: boolean;
  private adapterRun: AdapterRunState | null = null;

  constructor(options: DapClientOptions = {}) {
    this.adapterPath = options.adapterPath ?? defaultAdapterPath;
    this.nodePath = options.nodePath ?? process.execPath;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.connectIntervalMs = options.connectIntervalMs ?? 100;
    this.autoSocketPath = options.socketPath === undefined && process.platform !== 'win32';
    this.socketPathValue = options.socketPath ?? null;
    this.autoTcpPort = options.tcpPort === undefined;
    this.tcpPortValue = options.tcpPort ?? randomTcpPort();
    this.transcript = options.transcript ?? [];
    this.startDebuggingHandler = options.startDebuggingHandler ?? null;
    this.traceId = options.traceId ?? nextDapTraceId();
  }

  async spawnServer(): Promise<this> {
    if (this.autoSocketPath && this.socketDir === null) {
      const dir = await createPrivateSocketDir();
      // 建目录期间已被 dispose:dispose 看不到它,就地删掉,不再 spawn。
      if (this.disposed) {
        await fs.rm(dir, { recursive: true, force: true });
        throw new Error('DAP client disposed');
      }
      this.socketDir = dir;
      this.socketPathValue = path.join(dir, SOCKET_FILE_NAME);
    }
    if (this.socketPath) {
      await fs.rm(this.socketPath, { force: true });
    }

    // TCP 随机端口可能与另一会话的 adapter 撞上:本 adapter 因 EADDRINUSE 在就绪前退出 → 换端口重 spawn。
    // socket 路径是私有目录内的唯一路径,不会冲突,只试一次。
    const attempts = !this.socketPath && this.autoTcpPort ? TCP_SPAWN_ATTEMPTS : 1;
    let socket: Socket;
    for (let attempt = 1; ; attempt += 1) {
      this.spawnAdapter();
      try {
        socket = await this.waitForReady();
        break;
      } catch (err) {
        if (!(err instanceof AdapterExitedEarlyError) || attempt >= attempts || this.disposed) {
          throw err;
        }
        this.tcpPortValue = randomTcpPort();
      }
    }
    this.socket = socket;
    this.attachSocket(socket);
    return this;
  }

  private spawnAdapter(): void {
    const endpoint = this.socketPath ?? String(this.tcpPort);
    // nodePath 默认 process.execPath。在打包/dev 的 Electron 里 process.execPath 是
    // Electron 二进制,必须设 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 跑 dapDebugServer.js;
    // 否则 Electron 会把脚本当成 app 入口加载 → "Dynamic require of fs is not supported"。
    // 同时按 safeguard 剥离敏感 env(不把 CONTINUO_MCP_TOKEN 泄漏给 adapter/debuggee)。
    const adapterEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    };
    delete adapterEnv.CONTINUO_MCP_TOKEN;
    // TCP(Windows):dapDebugServer.js 的第二个参数是 host,默认 localhost 可能解析成 ::1,
    // 而 connectOnce 固定连 127.0.0.1 → 显式传同一地址。socket 路径模式不需要 host。
    // 127.0.0.1 端口本机其它用户也能连:改命名管道 + 收紧 ACL 见 doc/follow-ups.md「Windows 上 DAP 端点改用命名管道」。
    const adapterArgs = this.socketPath
      ? [this.adapterPath, endpoint]
      : [this.adapterPath, endpoint, DAP_TCP_HOST];
    const server = spawn(this.nodePath, adapterArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: adapterEnv,
    });
    this.server = server;
    // 必须是 spawn 之后的第一件事:fd 耗尽(EMFILE / ENFILE)时返回的 ChildProcess 没有 stdio,先碰
    // server.stderr 会同步抛 TypeError,'error' 监听就挂不上了。
    // spawn 失败(ENOENT / EMFILE …)以 'error' 事件上报;ChildProcess 的 'error' 无监听会直接抛成主进程
    // 未捕获异常。记下来让 waitForReady 立刻失败(不必等满 readyTimeout),并结算在途请求。
    server.once('error', (err) => {
      this.spawnError = err;
      this.rejectAllPending(err);
    });
    // 每次 spawn 一份状态:重试后旧进程的迟到事件不影响新一次的判定。
    this.serverStderr = '';
    let markClosed: () => void = () => {};
    const run: AdapterRunState = {
      exited: null,
      closed: new Promise<void>((resolve) => {
        markClosed = resolve;
      }),
      listening: false,
      stdoutHead: '',
    };
    this.adapterRun = run;
    server.once('close', markClosed);
    server.stderr?.on('data', (chunk: Buffer) => {
      // 只用于 ready 超时的报错信息:封顶,不随 adapter 生命周期无界累积。
      if (this.serverStderr.length < SERVER_STDERR_MAX_CHARS) {
        this.serverStderr = (this.serverStderr + chunk.toString('utf8')).slice(
          0,
          SERVER_STDERR_MAX_CHARS,
        );
      }
    });
    server.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (!run.listening) {
        run.stdoutHead = (run.stdoutHead + text).slice(-SERVER_STDERR_MAX_CHARS);
        run.listening = run.stdoutHead.includes(ADAPTER_LISTENING_MARK);
      }
      this.recordTranscript({
        direction: 'server-stdout',
        text,
      });
    });
    server.once('exit', (code, signal) => {
      run.exited = `code=${code} signal=${signal}`;
      this.rejectAllPending(
        new Error(`DAP server exited code=${code} signal=${signal}`),
      );
    });
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
      traceId: `${this.traceId}>child${this.childSessionSeq++}`,
      ...options,
    });
    child.parentSession = this;
    this.childSessions.push(child);
    return child;
  }

  setStartDebuggingHandler(handler: StartDebuggingHandler | null): void {
    this.startDebuggingHandler = handler;
  }

  async waitForReady(): Promise<Socket> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastError: Error | undefined;
    const run = this.adapterRun;

    while (Date.now() < deadline) {
      if (this.spawnError) {
        throw new Error(`DAP server failed to spawn: ${this.spawnError.message}`);
      }
      // 本 adapter 已退出:端口上若还有监听者那也是别人(如撞端口的另一会话的 adapter),不能连。
      if (run?.exited) throw await this.exitedEarlyError(run);
      // TCP:端口可能被别的进程占着,能连上不代表是本 adapter → 等它在 stdout 报告 listen 成功再连。
      // socket 路径在私有目录内唯一,连得上即是本 adapter。
      if (run && !this.socketPath && !run.listening) {
        await sleep(this.connectIntervalMs);
        continue;
      }
      let socket: Socket;
      try {
        socket = await this.connectOnce();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await sleep(this.connectIntervalMs);
        continue;
      }
      // 连接期间本 adapter 退出了:连上的不是它。
      if (run?.exited) {
        socket.destroy();
        throw await this.exitedEarlyError(run);
      }
      return socket;
    }

    const detail = lastError ? ` last error: ${lastError.message}` : '';
    throw new Error(
      `DAP server readiness timed out after ${this.readyTimeoutMs}ms.${detail}\n` +
        `server stderr:\n${this.serverStderr}`,
    );
  }

  private async exitedEarlyError(run: AdapterRunState): Promise<AdapterExitedEarlyError> {
    // 'exit' 可能早于 stderr 读完:等 stdio 关闭(有界)再取 stderr 进报错。
    await Promise.race([run.closed, sleep(1_000)]);
    return new AdapterExitedEarlyError(
      `DAP server exited before ready (${run.exited}).\nserver stderr:\n${this.serverStderr}`,
    );
  }

  connectOnce(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.socketPath
        ? net.connect(this.socketPath)
        : net.connect({ port: this.tcpPort, host: DAP_TCP_HOST });
      socket.once('connect', () => resolve(socket));
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  attachSocket(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      if (socket.destroyed) return;
      let frames: DapDecodedFrame[];
      try {
        frames = this.decoder.pushFrames(chunk);
      } catch (err) {
        // 畸形流(缺 Content-Length / 帧头超限 / body 非 JSON):解码器缓冲不会前进,之后每个 chunk 都会重抛。
        // 在 data 回调里抛出就是主进程未捕获异常 —— 结算在途请求并断开这条连接。
        this.rejectAllPending(
          new Error(`malformed DAP stream: ${err instanceof Error ? err.message : String(err)}`),
        );
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        this.receiveMessage(frame.message, frame.bodyBytes);
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
    let off: () => void = () => {};
    return withTimeout(
      new Promise<DapEventMessage>((resolve) => {
        off = this.on(eventName, (event) => {
          off();
          resolve(event);
        });
      }),
      timeoutMs,
      `event ${eventName}`,
    ).finally(() => off()); // 超时也摘监听(成功路径已摘过,重复摘无害)
  }

  sendRequest(
    command: string,
    args: DapJson = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<DapResponseMessage> {
    const request = this.createRequest(command, args);
    // 先发后登记:socket 已断时 sendMessage 同步抛。若先建好带超时的 Promise 再抛,那个 Promise 没人接管,
    // 到点 reject 成 unhandledRejection(main 没有全局兜底)。失败统一以 rejected Promise 返回。
    try {
      this.sendMessage(request);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return withTimeout(
      new Promise<DapResponseMessage>((resolve, reject) => {
        this.pending.set(request.seq, { resolve, reject });
      }),
      timeoutMs,
      `request ${command}`,
    ).finally(() => {
      // 超时后不再等这个响应:删掉条目(正常响应 / rejectAllPending 路径已删,重复删无害)。
      this.pending.delete(request.seq);
      if (this.pending.size === 0) {
        for (const resume of this.idleWaiters.splice(0)) resume();
      }
    });
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

  // transcript 只保留最近 DAP_TRANSCRIPT_MAX_ENTRIES 条、总计不超过 DAP_TRANSCRIPT_MAX_BYTES(父子 session
  // 共享同一数组与同一预算),单条按 DAP_TRANSCRIPT_ENTRY_MAX_BYTES 截断。超限时一次裁到条数与字节都不超过
  // 上限的一半(摊还 O(1),避免每条消息都 shift)。
  private recordTranscript(raw: DapTranscriptEntry, messageBytes?: number): void {
    const transcript = this.transcript;
    const { entry, bytes } = boundTranscriptEntry(raw, messageBytes);
    transcript.push(entry);
    transcriptEntryBytes.set(entry, bytes);
    let total = (transcriptBytes.get(transcript) ?? 0) + bytes;
    if (transcript.length > DAP_TRANSCRIPT_MAX_ENTRIES || total > DAP_TRANSCRIPT_MAX_BYTES) {
      let drop = 0;
      while (
        drop < transcript.length - 1 &&
        (transcript.length - drop > DAP_TRANSCRIPT_MAX_ENTRIES / 2 ||
          total > DAP_TRANSCRIPT_MAX_BYTES / 2)
      ) {
        total -= transcriptEntryBytes.get(transcript[drop]!) ?? 0;
        drop += 1;
      }
      transcript.splice(0, drop);
    }
    transcriptBytes.set(transcript, total);
  }

  sendMessage(message: DapMessage): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('DAP socket is not connected');
    }
    // 只序列化一次:同一份 body 既用于 transcript 计量也用于成帧。
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.recordTranscript({ direction: 'client', message }, body.length);
    traceDap(this.traceId, 'send', message);
    this.socket.write(frameDapBody(body));
  }

  /** wireBytes:该消息帧体的线上字节数(来自 decoder);未知时(合成响应 / 直接调用)transcript 自行计量。 */
  receiveMessage(message: DapMessage, wireBytes?: number): void {
    this.recordTranscript({ direction: 'server', message }, wireBytes);
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
      // 兜底:回复内部已吞掉写失败,这里再接一层,保证 Promise 必定结算、不成为 unhandledRejection。
      this.respondToReverseRequest(message).catch(() => undefined);
    }
  }

  /**
   * 写反向请求的回复。handler 可能跨越 dispose(child 初始化期间 socket 被关):此时回复已无人接收,
   * 静默放弃;写本身抛错同样吞掉(sendMessage 在 socket 断开时同步抛)。
   */
  private sendReverseResponse(message: DapMessage): void {
    if (this.disposed || !this.socket || this.socket.destroyed) return;
    try {
      this.sendMessage(message);
    } catch {
      // socket 在写入前后断开:回复无人接收
    }
  }

  async respondToReverseRequest(message: DapRequestMessage): Promise<void> {
    if (message.command === 'startDebugging' && this.startDebuggingHandler) {
      try {
        const body = await this.startDebuggingHandler(message, this);
        this.sendReverseResponse({
          seq: this.seq++,
          type: 'response',
          request_seq: message.seq ?? 0,
          command: message.command,
          success: true,
          body: body ?? {},
        });
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        this.sendReverseResponse({
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
    this.sendReverseResponse({
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

  /**
   * 等在途请求全部结算后再 dispose(无在途请求时立即 dispose)。用于回收已结束(terminated / exited)的
   * child:js-debug 可能在 terminated 之后才回在途请求(如 continue)的响应,当即关 socket 会让它以
   * 「DAP socket closed」失败。每个请求都有自己的超时,等待有界。
   */
  disposeWhenIdle(): Promise<void> {
    if (this.pending.size === 0) return this.dispose();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve)).then(() => this.dispose());
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.parentSession) {
      const siblings = this.parentSession.childSessions;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentSession = null;
    }

    // 取快照:child 的 dispose 会同步把自己从本列表摘除。
    await Promise.all(
      [...this.childSessions].map((child) => child.dispose().catch(() => undefined)),
    );
    this.childSessions = [];
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    // 只有自己 spawn 过 adapter 的(父)client 才清 adapter 进程与监听 socket 文件。child 与父共用同一个
    // socketPath:单独释放一个 child(握手失败)时删掉它,仍在运行的 adapter 就再也连不上了。
    if (this.server) {
      await this.killServer();
      if (this.socketPath) {
        await fs.rm(this.socketPath, { force: true });
      }
    }
    if (this.socketDir) {
      await fs.rm(this.socketDir, { recursive: true, force: true });
      this.socketDir = null;
    }
  }

  /**
   * adapter 监听的 unix socket 路径。POSIX 默认在 spawnServer 时于私有目录内新建(此前为 null);
   * Windows 为 null(用 TCP)。
   */
  get socketPath(): string | null {
    return this.socketPathValue;
  }

  /** TCP 模式(Windows)adapter 监听的端口;随机端口冲突重试后会变。 */
  get tcpPort(): number {
    return this.tcpPortValue;
  }

  /** debug adapter 子进程 pid(未 spawn / child session → undefined)。 */
  get serverPid(): number | undefined {
    return this.server?.pid;
  }

  /** adapter 子进程退出时回调(已退出则下一微任务回调;未 spawn 不回调)。 */
  onServerExit(listener: () => void): void {
    const server = this.server;
    if (!server) return;
    if (this.serverExited) queueMicrotask(listener);
    else server.once('exit', () => listener());
  }

  /** adapter 子进程已退出(未 spawn → false)。退出后其 pid 可能被复用,调用方不能再对它发信号。 */
  get serverExited(): boolean {
    return (
      this.server !== null &&
      (this.server.exitCode !== null || this.server.signalCode !== null)
    );
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
