// 规则 3:stdio 每连接串行队列有总深度上限。首请求阻塞(如卡在授权弹窗)时,客户端持续发小
// chunk(每 chunk 都在单 chunk 行数上限内)此前可无限堆积排队行 → main 内存无界增长。
// 超限时错误必须真正送达客户端:此前 write(error) 后立即 destroy(),对端可能因 RST 丢掉错误行
// → 改为 end(error) 半关闭 + 兜底超时 destroy。这里从真实客户端读取,断言收到完整 PARSE_ERROR。
import { connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// tools/call 需要 owner 窗口:无 hello → fallback 到 getAllWindows 的第一个非 popout 窗口。
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { id: 1, isDestroyed: () => false, webContents: { getURL: () => 'app://main' } },
    ],
    fromId: () => null,
  },
}));

import {
  createStdioSocketServer,
  MAX_STDIO_PENDING_LINES,
  type StdioSocketServer,
} from '../../../electron/main/services/mcp-stdio-server.service';
import type { AnyMcpTool, ServerInfo } from '../../../electron/main/services/mcp-host.service';
import { gateWithAuth } from '../../../electron/main/services/mcp-tool-gates';

const serverInfo: ServerInfo = { name: 't', version: '0', protocolVersion: '2024-11-05' };

const dirs: string[] = [];
const clients: Socket[] = [];
let server: StdioSocketServer | null = null;

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  if (server) {
    await server.close().catch(() => {});
    server = null;
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const isWin = process.platform === 'win32';

describe.skipIf(isWin)('规则 3 · stdio 每连接排队上限', () => {
  it('首请求阻塞时持续发小 chunk → 超排队上限即 PARSE_ERROR + 断开', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'continuo-stdio-cap-'));
    dirs.push(dir);
    const socketPath = join(dir, 'mcp.sock');
    const block: AnyMcpTool = {
      name: 'block',
      description: '',
      jsonSchema: {},
      inputSchema: { safeParse: (a: unknown) => ({ success: true, data: a }) },
      run: () => new Promise(() => {}), // 永不返回:模拟卡在授权弹窗
    } as unknown as AnyMcpTool;
    server = await createStdioSocketServer({
      socketPath,
      tools: new Map([['block', block]]),
      serverInfo,
      resolveWindowId: () => null,
    });

    const client = connect(socketPath);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    let received = '';
    client.setEncoding('utf8');
    client.on('data', (d: string) => (received += d));
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.on('error', () => {});

    client.write(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'block' } }) +
        '\n',
    );
    // 每行 ~200B,每批 200 行(~40KB,远低于单 chunk 1024 行上限),批次间让出事件循环。
    const pad = 'x'.repeat(150);
    let id = 1;
    let isClosed = false;
    void closed.then(() => (isClosed = true));
    for (let batch = 0; batch < Math.ceil((MAX_STDIO_PENDING_LINES + 400) / 200); batch++) {
      if (isClosed) break;
      let buf = '';
      for (let i = 0; i < 200; i++) {
        buf += JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'ping', params: { pad } }) + '\n';
      }
      client.write(buf);
      await new Promise((r) => setTimeout(r, 5));
    }

    const outcome = await Promise.race([
      closed.then(() => 'closed' as const),
      new Promise<'open'>((r) => setTimeout(() => r('open'), 2000)),
    ]);
    expect(outcome).toBe('closed');
    // 客户端收到完整(以换行结束、可解析)的 JSON-RPC PARSE_ERROR,随后连接关闭
    const errors = received
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { id: unknown; error?: { code: number; message: string } })
      .filter((m) => m.error !== undefined);
    expect(received.endsWith('\n')).toBe(true);
    expect(errors).toEqual([
      expect.objectContaining({
        id: null,
        error: expect.objectContaining({ code: -32700, message: 'too many pending requests' }),
      }),
    ]);
  });
});

// 规则 3(续):进入拒绝状态(end(PARSE_ERROR))后,监听 ctx.signal 的在途调用因 abort 返回,不得再
// 写响应(write-after-end → ERR_STREAM_WRITE_AFTER_END 销毁 socket,未 flush 的 PARSE_ERROR 被截断);
// 已排队的后续行直接丢弃,不进 gateWithAuth → 不产生迟到授权弹窗。
describe.skipIf(isWin)('规则 3 · 拒绝后不再写响应 / 不再处理排队行', () => {
  const echo = (name: string, run: AnyMcpTool['run']): AnyMcpTool =>
    ({
      name,
      description: '',
      jsonSchema: {},
      inputSchema: { safeParse: (a: unknown) => ({ success: true, data: a }) },
      run,
    }) as unknown as AnyMcpTool;
  // 监听连接取消信号的长调用:abort 时立即返回。
  const waiter = echo(
    'waiter',
    (_input, ctx) =>
      new Promise((resolve) =>
        ctx.signal?.addEventListener('abort', () => resolve({ aborted: true }), { once: true }),
      ),
  );
  const call = (id: number, name: string): string =>
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }) + '\n';

  async function start(tools: AnyMcpTool[]): Promise<Socket> {
    const dir = await mkdtemp(join(tmpdir(), 'continuo-stdio-rej-'));
    dirs.push(dir);
    const socketPath = join(dir, 'mcp.sock');
    server = await createStdioSocketServer({
      socketPath,
      tools: new Map(tools.map((t) => [t.name, t])),
      serverInfo,
      resolveWindowId: () => null,
    });
    const client = connect(socketPath);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.on('error', () => {});
    return client;
  }

  it('在途调用因 abort 返回 → 不写响应,PARSE_ERROR 完整送达', async () => {
    const big = echo('big', async () => ({ text: 'y'.repeat(32 * 1024) }));
    const client = await start([big, waiter]);
    // 客户端暂不读取:让 ~1.3MB 响应积压在服务端写缓冲,PARSE_ERROR 排在其后尚未 flush。
    client.pause();
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    let buf = '';
    for (let i = 0; i < 40; i++) buf += call(i, 'big');
    buf += call(100, 'waiter');
    client.write(buf);
    await new Promise((r) => setTimeout(r, 100));
    // 超单行字节上限的残行 → 拒绝(end(PARSE_ERROR) + abort 在途 waiter)。
    client.write('z'.repeat(1_100_000));
    await new Promise((r) => setTimeout(r, 200));

    let received = '';
    client.setEncoding('utf8');
    client.on('data', (d: string) => (received += d));
    client.resume();
    await closed;

    const msgs = received
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { id: unknown; error?: { code: number; message: string } });
    expect(received.endsWith('\n')).toBe(true);
    expect(msgs.at(-1)).toMatchObject({
      id: null,
      error: { code: -32700, message: 'line exceeds maximum size' },
    });
    expect(msgs.some((m) => m.id === 100)).toBe(false);
  });

  it('拒绝后已排队的行直接丢弃:不 dispatch、不进授权门控(不弹迟到授权窗)', async () => {
    const ensureAuthorized = vi.fn(async () => 'session' as const);
    const gated = gateWithAuth(
      echo('gated', async () => ({ ok: true })),
      ensureAuthorized,
      { methodFor: (t) => t.name, deniedMessage: 'denied' },
    );
    const plainRun = vi.fn(async () => ({ ok: true }));
    const plain = echo('plain', plainRun);
    const client = await start([waiter, gated, plain]);
    client.resume(); // 消费服务端输出,使半关闭后的 close 能触发
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    let buf = call(0, 'waiter');
    for (let i = 1; i <= 5; i++) buf += call(i, 'gated');
    buf += call(6, 'plain');
    client.write(buf);
    await new Promise((r) => setTimeout(r, 50));
    client.write('z'.repeat(1_100_000));
    await closed;
    await new Promise((r) => setTimeout(r, 50));

    expect(ensureAuthorized).not.toHaveBeenCalled();
    expect(plainRun).not.toHaveBeenCalled();
  });

  // 拒绝半关闭期间的 broadcast 同样不得写入(此前 broadcast 直接 c.write(),未跳过 writableEnded /
  // destroyed 的连接 → ERR_STREAM_WRITE_AFTER_END 销毁 socket,截断未 flush 的 PARSE_ERROR)。
  it('半关闭期间 broadcast → PARSE_ERROR 仍完整送达,其后无通知行', async () => {
    const big = echo('big', async () => ({ text: 'y'.repeat(32 * 1024) }));
    const client = await start([big]);
    // 客户端暂不读取:让大响应积压在服务端写缓冲,PARSE_ERROR 排在其后尚未 flush。
    client.pause();
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    let buf = '';
    for (let i = 0; i < 40; i++) buf += call(i, 'big');
    client.write(buf);
    await new Promise((r) => setTimeout(r, 100));
    client.write('z'.repeat(1_100_000)); // 超单行字节上限 → 拒绝(end(PARSE_ERROR))
    await new Promise((r) => setTimeout(r, 200));
    server!.broadcast('notifications/tools/list_changed');

    let received = '';
    client.setEncoding('utf8');
    client.on('data', (d: string) => (received += d));
    client.resume();
    await closed;

    const msgs = received
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { id?: unknown; method?: string });
    expect(received.endsWith('\n')).toBe(true);
    expect(msgs.at(-1)).toMatchObject({
      id: null,
      error: { code: -32700, message: 'line exceeds maximum size' },
    });
    expect(msgs.some((m) => m.method === 'notifications/tools/list_changed')).toBe(false);
  });
});
