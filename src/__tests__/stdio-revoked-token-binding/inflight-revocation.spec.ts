// 安全:stdio 连接的调用在途时 token 被吊销 → 调用被取消、结果不写回(与 HTTP 对齐)。行为见同目录 README「在途调用」。
// 真实 createMcpHost + 真实回收接线(createMcpRevokerWiring)+ 真实 stdio server + unix socket + 真实终端工具;
// 只 mock electron 的窗口、PTY 服务与授权弹窗(由测试控制何时应答)。
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const win = vi.hoisted(() => ({ alive: new Set<number>() }));
vi.mock('electron', () => ({
  BrowserWindow: {
    fromId: vi.fn((id: number) => (win.alive.has(id) ? { isDestroyed: () => false } : null)),
    getAllWindows: vi.fn(() =>
      [...win.alive].map((id) => ({
        id,
        isDestroyed: () => false,
        webContents: { getURL: () => 'file:///renderer/index.html' },
      })),
    ),
  },
}));

import {
  createStdioSocketServer,
  type StdioSocketServer,
} from '../../../electron/main/services/mcp-stdio-server.service';
import {
  createMcpHost,
  type AnyMcpTool,
  type McpCallCtx,
  type McpHost,
  type McpRevokers,
} from '../../../electron/main/services/mcp-host.service';
import { createMcpRevokerWiring } from '../../../electron/main/services/mcp-revoker-wiring';
import { makeTerminalMcpTools } from '../../../electron/main/services/mcp-terminal-host';
import {
  createAwaitStopHookTool,
  type HookFileBroker,
} from '../../../electron/main/services/mcp-tools-hook-bridge';
import * as sessions from '../../../electron/main/services/terminal-sessions.service';
import {
  cancelAgentTerminalCreates,
  hasAgentTerminalCreates,
} from '../../../electron/main/services/agent-terminal-inflight';

const NO_WINDOW_CTX = -32002;
const WINDOW = 7;
const SECRET = 'SECRET-TRANSCRIPT-CONTENT';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Reply {
  readonly errorCode: number | string | null;
  readonly errorMessage: string | null;
  /** 成功时工具返回的 JSON(tools/call 的 content[0].text 解析后)。 */
  readonly value: Record<string, unknown> | null;
  /** 响应行原文(断言不含敏感内容)。 */
  readonly raw: string;
}

interface Client {
  hello(windowId: number, token: string): void;
  call(name: string, args?: Record<string, unknown>): Promise<Reply>;
}

const dirs: string[] = [];
const sockets: Socket[] = [];
let server: StdioSocketServer | null = null;
let host: McpHost | null = null;

afterEach(async () => {
  for (const sk of sockets.splice(0)) sk.destroy();
  await server?.close().catch(() => undefined);
  server = null;
  await host?.close().catch(() => undefined);
  host = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  win.alive.clear();
  sessions._reset();
  cancelAgentTerminalCreates();
});

interface Harness {
  readonly host: McpHost;
  readonly revokers: McpRevokers;
  connect(): Promise<Client>;
  /** HTTP 对照:带 token 调工具。 */
  http(token: string, name: string, args?: Record<string, unknown>): Promise<Reply>;
  /** 授权弹窗:每次调用工具门控都会进来;设了 gate 就挂到它 resolve。 */
  readonly auth: { calls: number; gate: Deferred<'session' | 'denied'> | null };
  /** PTY 创建:设了 gate 就挂到它 resolve。 */
  readonly create: { calls: number; gate: Deferred<void> | null; autoruns: string[] };
  readonly pty: Set<string>;
  /** await_stop_hook 的 broker:记下等待者的 signal,由测试决定何时交出事件。 */
  readonly stopHook: { signal: AbortSignal | null; deliver: Deferred<void> | null };
  /** 普通慢工具 `slow`:挂到 gate resolve 后返回 SECRET 与调用方身份。 */
  readonly slow: { calls: number; gate: Deferred<void> | null; signals: AbortSignal[] };
  readonly debugKilled: string[];
}

function parseReply(raw: string): Reply {
  const msg = JSON.parse(raw) as {
    error?: { code: number; message: string; data?: { code?: string } };
    result?: { content?: { text: string }[] };
  };
  if (msg.error) {
    return {
      errorCode: msg.error.data?.code ?? msg.error.code,
      errorMessage: msg.error.message,
      value: null,
      raw,
    };
  }
  const text = msg.result?.content?.[0]?.text;
  return {
    errorCode: null,
    errorMessage: null,
    value: text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>),
    raw,
  };
}

async function start(): Promise<Harness> {
  win.alive.add(WINDOW);
  const dir = await mkdtemp(path.join(tmpdir(), 'continuo-stdio-inflight-'));
  dirs.push(dir);
  const socketPath = path.join(dir, 'mcp.sock');

  const auth: Harness['auth'] = { calls: 0, gate: null };
  const create: Harness['create'] = { calls: 0, gate: null, autoruns: [] };
  const stopHook: Harness['stopHook'] = { signal: null, deliver: null };
  const slow: Harness['slow'] = { calls: 0, gate: null, signals: [] };
  const pty = new Set<string>();
  const debugKilled: string[] = [];
  let seq = 0;

  const broker: HookFileBroker = {
    hookEventsDir: dir,
    start: async () => undefined,
    stop: async () => undefined,
    cancelByWindow: () => 0,
    // 故意不理会 signal:即使 broker 仍交出事件,结果也不得写回。
    awaitNext: async (_filter, signal) => {
      stopHook.signal = signal ?? null;
      await stopHook.deliver?.promise;
      return {
        payload: {
          cliSessionId: 'cli-1',
          turnId: 'turn-1',
          cwd: '/tmp',
          transcriptPath: `/tmp/${SECRET}.jsonl`,
          lastAssistantMessage: SECRET,
        },
      } as never;
    },
  };

  const slowTool: AnyMcpTool = {
    name: 'slow',
    description: 'slow tool',
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run: async (_input: unknown, ctx: McpCallCtx) => {
      slow.calls += 1;
      if (ctx.signal) slow.signals.push(ctx.signal);
      await slow.gate?.promise;
      return { secret: SECRET, subject: ctx.callerSubject, external: ctx.external === true };
    },
  };

  const tools = makeTerminalMcpTools({
    sessionStore: sessions,
    service: {
      has: (id: string) => pty.has(id),
      write: async (id: string) => pty.has(id),
      interrupt: async (id: string) => pty.has(id),
      kill: (id: string) => void pty.delete(id),
      forceKill: (id: string) => void pty.delete(id),
      readOutput: async () => ({ data: SECRET, lines: [SECRET], nextSeq: 1, truncated: false }),
    } as never,
    getSessionOwner: (id) => sessions.get(id)?.ownerWindowId ?? null,
    getSessionController: (id) => sessions.getController(id),
    ensureAuthorized: async () => {
      auth.calls += 1;
      return auth.gate ? auth.gate.promise : 'session';
    },
    // 复刻 index.ts createSessionForAgent:先登记 metadata,再(异步)起 PTY,autorun 在 PTY 起来后跑。
    createSession: async (input, ctx) => {
      create.calls += 1;
      const id = `term-${(seq += 1)}`;
      sessions.add({
        id,
        title: id,
        cwd: '/tmp',
        originHint: 'agent',
        agentLabel: input.agentLabel,
        ownerWindowId: ctx.ownerWindowId,
        ...(typeof ctx.callerSubject === 'string' ? { controllerToken: ctx.callerSubject } : {}),
      });
      await create.gate?.promise;
      pty.add(id);
      if (input.autorun && !ctx.signal?.aborted) create.autoruns.push(input.autorun);
      return { id };
    },
    awaitStopHookTool: createAwaitStopHookTool({
      broker,
      getSessionMeta: (id) => sessions.get(id) ?? null,
    }),
  });

  const wiring = createMcpRevokerWiring({
    debugService: {
      killByController: async (subject) => {
        debugKilled.push(subject);
      },
      listControllerTokens: () => [],
    },
    cancelAgentTerminalCreates,
    hasAgentTerminalCreates,
    hasLiveSessionForController: sessions.hasLiveSessionForController,
  });
  const h = await createMcpHost({ initialTools: [...tools, slowTool], ...wiring.hostOptions });
  host = h;
  server = await createStdioSocketServer({
    socketPath,
    tools: h.tools,
    serverInfo: h.serverInfo,
    resolveWindowId: (token) => h.resolveWindowId(token),
    ...wiring.stdioOptions,
  });

  let rpcId = 0;
  const connect = async (): Promise<Client> => {
    const socket = createConnection(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    socket.setEncoding('utf8');
    let buffer = '';
    const waiters = new Map<number, (reply: Reply) => void>();
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const id = (JSON.parse(line) as { id: number }).id;
        waiters.get(id)?.(parseReply(line));
        waiters.delete(id);
      }
    });
    const send = (msg: Record<string, unknown>): void => {
      socket.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    };
    return {
      hello: (windowId, token) => send({ method: '_continuo/hello', params: { windowId, token } }),
      call: (name, args = {}) =>
        new Promise<Reply>((resolve) => {
          const id = (rpcId += 1);
          waiters.set(id, resolve);
          send({ id, method: 'tools/call', params: { name, arguments: args } });
        }),
    };
  };

  const http: Harness['http'] = async (token, name, args = {}) => {
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: (rpcId += 1),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return parseReply(await res.text());
  };

  return {
    host: h,
    revokers: wiring.revokers(h),
    connect,
    http,
    auth,
    create,
    pty,
    stopHook,
    slow,
    debugKilled,
  };
}

/** 三个吊销入口。 */
const REVOCATIONS: readonly [string, (h: Harness, token: string) => void][] = [
  ['单个 token 被吊销(持有它的终端退出)', (h, token) => h.revokers.byToken(token)],
  ['按窗口吊销(revokeWindowTokens)', (h) => h.revokers.byWindow(WINDOW)],
  ['撤销全部(rotateToken)', (h) => h.host.rotateToken()],
];

describe.skipIf(process.platform === 'win32')('stdio:在途调用跨越 token 吊销', () => {
  it('审计复现:create_session{autorun} 卡在授权弹窗 → token 被吊销 → 用户点允许 → 不建会话、不跑 autorun、返回错误(HTTP 同序列同样失败)', async () => {
    const h = await start();
    const token = h.host.issueWindowToken(WINDOW);
    const c = await h.connect();
    c.hello(WINDOW, token);

    h.auth.gate = deferred();
    const inflight = c.call('terminal.create_session', { autorun: 'echo pwned' });
    // 排在后面的调用(吊销后才出队)。
    const queued = c.call('slow');
    await vi.waitFor(() => expect(h.auth.calls).toBe(1));
    h.revokers.byToken(token);
    h.auth.gate.resolve('session');

    const reply = await inflight;
    expect(reply.errorCode).toBe(NO_WINDOW_CTX);
    expect((await queued).errorCode).toBe(NO_WINDOW_CTX);
    expect(h.create.calls).toBe(0);
    expect(h.create.autoruns).toEqual([]);
    expect(sessions.getAll()).toEqual([]);
    expect(h.slow.calls).toBe(0);

    // HTTP 对照(行为不变)。
    const httpToken = h.host.issueWindowToken(WINDOW);
    h.auth.gate = deferred();
    const viaHttp = h.http(httpToken, 'terminal.create_session', { autorun: 'echo pwned' });
    await vi.waitFor(() => expect(h.auth.calls).toBe(2));
    h.revokers.byToken(httpToken);
    h.auth.gate.resolve('session');
    expect(await viaHttp).toMatchObject({
      errorCode: 'AGENT_NOT_AUTHORIZED',
      errorMessage: expect.stringContaining('revoked before session creation'),
    });
    expect(h.create.calls).toBe(0);
  });

  it('授权已过、PTY 创建中被吊销 → 新会话被回收、不跑 autorun、返回错误', async () => {
    const h = await start();
    const token = h.host.issueWindowToken(WINDOW);
    const c = await h.connect();
    c.hello(WINDOW, token);

    h.create.gate = deferred();
    const inflight = c.call('terminal.create_session', { autorun: 'echo pwned' });
    await vi.waitFor(() => expect(h.create.calls).toBe(1));
    h.revokers.byToken(token);
    h.create.gate.resolve();

    expect((await inflight).errorCode).toBe(NO_WINDOW_CTX);
    expect(h.create.autoruns).toEqual([]);
    expect(sessions.getAll()).toEqual([]);
    expect(h.pty.size).toBe(0);
  });

  it('await_stop_hook 在途时被吊销 → 等待被取消,即使事件随后到达也不返回 transcript 内容', async () => {
    const h = await start();
    const token = h.host.issueWindowToken(WINDOW);
    const c = await h.connect();
    c.hello(WINDOW, token);
    const created = await c.call('terminal.create_session', { agentLabel: 'claude' });
    const sessionId = created.value!['session_id'] as string;

    h.stopHook.deliver = deferred();
    const inflight = c.call('terminal.await_stop_hook', { session_id: sessionId });
    await vi.waitFor(() => expect(h.stopHook.signal).not.toBeNull());
    expect(h.stopHook.signal!.aborted).toBe(false);
    h.revokers.byToken(token);
    expect(h.stopHook.signal!.aborted).toBe(true);
    h.stopHook.deliver.resolve();

    const reply = await inflight;
    expect(reply.errorCode).toBe(NO_WINDOW_CTX);
    expect(reply.raw).not.toContain(SECRET);
  });

  it.each(REVOCATIONS)('%s:在途工具调用被取消(ctx.signal),结果丢弃改回 NO_WINDOW_CTX', async (_name, revoke) => {
    const h = await start();
    const token = h.host.issueWindowToken(WINDOW);
    const c = await h.connect();
    c.hello(WINDOW, token);

    h.slow.gate = deferred();
    const inflight = c.call('slow');
    await vi.waitFor(() => expect(h.slow.calls).toBe(1));
    expect(h.slow.signals[0]!.aborted).toBe(false);
    revoke(h, token);
    // 吊销当下即取消,不等这次调用结束或下一个请求进来。
    expect(h.slow.signals[0]!.aborted).toBe(true);
    h.slow.gate.resolve();

    const reply = await inflight;
    expect(reply.errorCode).toBe(NO_WINDOW_CTX);
    expect(reply.raw).not.toContain(SECRET);
  });

  it('吊销时回收该连接身份名下的 debug 会话;重新 hello 新 token 后恢复,且是新身份(不继承旧身份的会话)', async () => {
    const h = await start();
    const token = h.host.issueWindowToken(WINDOW);
    const c = await h.connect();
    c.hello(WINDOW, token);
    const before = await c.call('slow');
    const oldSubject = before.value!['subject'] as string;
    const created = await c.call('terminal.create_session', {});
    const sessionId = created.value!['session_id'] as string;

    h.slow.gate = deferred();
    const inflight = c.call('slow');
    await vi.waitFor(() => expect(h.slow.calls).toBe(2));
    h.revokers.byToken(token);
    expect(h.debugKilled).toContain(oldSubject);

    // 旧在途调用还没结束就重新 hello:行按序处理,新绑定不会让旧调用的结果写回。
    c.hello(WINDOW, h.host.issueWindowToken(WINDOW));
    const after = c.call('slow');
    h.slow.gate.resolve();
    expect((await inflight).errorCode).toBe(NO_WINDOW_CTX);
    const afterReply = await after;
    expect(afterReply.errorCode).toBeNull();
    expect(afterReply.value!['external']).toBe(false);
    expect(afterReply.value!['subject']).not.toBe(oldSubject);
    // 已创建的终端会话不被杀(同 HTTP 侧 token 吊销),但新身份无权读控它。
    expect(sessions.get(sessionId)).toBeDefined();
    expect((await c.call('terminal.read_output', { session_id: sessionId })).errorCode).not.toBeNull();
  });

  it('只影响绑定了被吊销 token 的连接:别的 token 的连接与未 hello 的外部客户端的在途调用照常完成', async () => {
    const h = await start();
    const revoked = h.host.issueWindowToken(WINDOW);
    const kept = h.host.issueWindowToken(WINDOW);
    const a = await h.connect();
    const b = await h.connect();
    const ext = await h.connect();
    a.hello(WINDOW, revoked);
    b.hello(WINDOW, kept);

    h.slow.gate = deferred();
    const fromA = a.call('slow');
    const fromB = b.call('slow');
    const fromExt = ext.call('slow');
    await vi.waitFor(() => expect(h.slow.calls).toBe(3));
    h.revokers.byToken(revoked);
    h.slow.gate.resolve();

    expect((await fromA).errorCode).toBe(NO_WINDOW_CTX);
    expect((await fromB).value).toMatchObject({ secret: SECRET, external: false });
    expect((await fromExt).value).toMatchObject({ secret: SECRET, external: true });
  });
});
