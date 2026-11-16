// 规则 3:stdio 每连接串行队列有总深度上限。首请求阻塞(如卡在授权弹窗)时,客户端持续发小
// chunk(每 chunk 都在单 chunk 行数上限内)此前可无限堆积排队行 → main 内存无界增长。
import { connect, Socket } from 'node:net';
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
    // 服务端断开时对端可能因未读数据收到 RST 而丢掉错误行 → 在进程内截获服务端 socket 的写入。
    const written: string[] = [];
    const origWrite = Socket.prototype.write;
    const spy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket['write']>
    ) {
      if (typeof args[0] === 'string') written.push(args[0]);
      return origWrite.apply(this, args);
    });
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
    spy.mockRestore();
    expect(outcome).toBe('closed');
    expect(written.some((w) => w.includes('too many pending requests'))).toBe(true);
    // 不是被单 chunk 行数 / 单行字节上限误伤
    expect(written.some((w) => w.includes('too many lines in one chunk'))).toBe(false);
  });
});
