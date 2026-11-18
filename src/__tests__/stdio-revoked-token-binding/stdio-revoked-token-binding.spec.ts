// 安全:token 被吊销 / 轮换后,用它 hello 绑定过的 stdio 连接立即失效(与 HTTP 的 401 对齐)。行为见同目录 README。
// 真实 mcp-host(token 表)+ 真实 stdio server + unix socket;只 mock electron 的窗口。
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
} from '../../../electron/main/services/mcp-host.service';

const NO_WINDOW_CTX = -32002;
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
});

type Run = ReturnType<typeof vi.fn<(input: unknown, ctx: McpCallCtx) => unknown>>;

async function start(): Promise<{ host: McpHost; socketPath: string; run: Run }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'continuo-stdio-revoked-'));
  dirs.push(dir);
  const socketPath = path.join(dir, 'mcp.sock');
  const run: Run = vi.fn((_input: unknown, ctx: McpCallCtx) => ({ owner: ctx.ownerWindowId }));
  const tool: AnyMcpTool = {
    name: 'whoami',
    description: 'return owner window',
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run,
  };
  const h = await createMcpHost({});
  host = h;
  server = await createStdioSocketServer({
    socketPath,
    tools: new Map([['whoami', tool]]),
    serverInfo: h.serverInfo,
    resolveWindowId: (token) => h.resolveWindowId(token),
  });
  return { host: h, socketPath, run };
}

interface Client {
  hello(windowId: number, token: string): void;
  /** tools/call whoami → JSON-RPC error code(成功为 null)。 */
  call(): Promise<number | null>;
  /** tools/list → 是否成功。 */
  list(): Promise<boolean>;
}

async function connect(socketPath: string): Promise<Client> {
  const socket = createConnection(socketPath);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.setEncoding('utf8');
  let buffer = '';
  const queue: Record<string, unknown>[] = [];
  const waiters: ((v: Record<string, unknown>) => void)[] = [];
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>;
      buffer = buffer.slice(idx + 1);
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    }
  });
  const send = (msg: Record<string, unknown>): void => {
    socket.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  };
  const next = (): Promise<Record<string, unknown>> =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise((resolve) => waiters.push(resolve));
  let id = 0;
  return {
    hello: (windowId, token) => send({ method: '_continuo/hello', params: { windowId, token } }),
    call: async () => {
      send({ id: (id += 1), method: 'tools/call', params: { name: 'whoami', arguments: {} } });
      const r = await next();
      return (r['error'] as { code: number } | undefined)?.code ?? null;
    },
    list: async () => {
      send({ id: (id += 1), method: 'tools/list' });
      return (await next())['error'] === undefined;
    },
  };
}

/** HTTP 侧:带 token 的 tools/list 的状态码。 */
async function httpStatus(h: McpHost, token: string): Promise<number> {
  const res = await fetch(h.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  await res.arrayBuffer();
  return res.status;
}

describe.skipIf(process.platform === 'win32')('stdio:token 吊销后已 hello 的连接失效', () => {
  it('单个 token 被吊销(终端退出)→ tools/call 回 NO_WINDOW_CTX、不执行工具;用新 token 重新 hello 恢复', async () => {
    win.alive.add(7);
    const { host: h, socketPath, run } = await start();
    const token = h.issueWindowToken(7);
    const c = await connect(socketPath);
    c.hello(7, token);
    expect(await c.call()).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toMatchObject({ ownerWindowId: 7 });
    expect(await httpStatus(h, token)).not.toBe(401);

    h.revokeToken(token);
    expect(await httpStatus(h, token)).toBe(401);
    expect(await c.call()).toBe(NO_WINDOW_CTX);
    expect(await c.call()).toBe(NO_WINDOW_CTX);
    expect(run).toHaveBeenCalledTimes(1);
    // tools/list 不需要窗口上下文,不受影响。
    expect(await c.list()).toBe(true);

    c.hello(7, h.issueWindowToken(7));
    expect(await c.call()).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![1]).toMatchObject({ ownerWindowId: 7 });
    expect(run.mock.calls[1]![1].external).toBeUndefined();
  });

  it('撤销全部(rotateToken)→ 所有已 hello 的连接失效,且不回落成 external 借主窗执行', async () => {
    win.alive.add(3);
    win.alive.add(7);
    const { host: h, socketPath, run } = await start();
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    a.hello(3, h.issueWindowToken(3));
    b.hello(7, h.issueWindowToken(7));
    expect(await a.call()).toBeNull();
    expect(await b.call()).toBeNull();

    h.rotateToken();
    expect(await a.call()).toBe(NO_WINDOW_CTX);
    expect(await b.call()).toBe(NO_WINDOW_CTX);
    expect(run).toHaveBeenCalledTimes(2);

    // 旧 token 重新 hello 无效;新签发的 token 可恢复。
    b.hello(7, 'stale-token');
    expect(await b.call()).toBe(NO_WINDOW_CTX);
    b.hello(7, h.issueWindowToken(7));
    expect(await b.call()).toBeNull();
    expect(run.mock.calls.at(-1)![1]).toMatchObject({ ownerWindowId: 7 });
  });

  it('按窗口吊销(revokeWindowTokens)→ 该窗口的连接失效,别的窗口的连接不受影响', async () => {
    win.alive.add(3);
    win.alive.add(7);
    const { host: h, socketPath, run } = await start();
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    a.hello(3, h.issueWindowToken(3));
    b.hello(7, h.issueWindowToken(7));
    // 先各调一次:确认 hello 已被处理(绑定已建立),再吊销。
    expect(await a.call()).toBeNull();
    expect(await b.call()).toBeNull();

    h.revokeWindowTokens(7); // 窗口 7 仍「存活」(只吊销了 token)
    expect(await b.call()).toBe(NO_WINDOW_CTX);
    expect(await a.call()).toBeNull();
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2]![1]).toMatchObject({ ownerWindowId: 3 });
  });

  it('同一窗口的另一个 token(另一个终端)被吊销 → 本连接不受影响', async () => {
    win.alive.add(7);
    const { host: h, socketPath } = await start();
    const mine = h.issueWindowToken(7);
    const other = h.issueWindowToken(7);
    const c = await connect(socketPath);
    c.hello(7, mine);
    h.revokeToken(other);
    expect(await c.call()).toBeNull();
  });

  it('未发 hello 的外部客户端不受吊销 / 轮换影响(仍以 external 回落主窗)', async () => {
    win.alive.add(3);
    const { host: h, socketPath, run } = await start();
    const c = await connect(socketPath);
    expect(await c.call()).toBeNull();
    h.revokeToken(h.issueWindowToken(3));
    h.rotateToken();
    expect(await c.call()).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![1]).toMatchObject({ ownerWindowId: 3, external: true });
  });
});
