// BDD: 50 · stdio 连接断开 → 通知「调用方失效」
// debug 会话归属创建它的 stdio 连接(callerSubject)。连接断开后新连接拿不到该 subject,
// 无权 disconnect;不回收就永久占名额、adapter 常驻。stdio server 在连接 close 时回调
// onCallerClosed(subject),main 据此回收该 subject 的 debug 会话。

import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('electron', () => ({
  BrowserWindow: {
    fromId: vi.fn(() => ({ isDestroyed: () => false })),
    getAllWindows: vi.fn(() => []),
  },
}));

import {
  createStdioSocketServer,
  type StdioSocketServer,
} from '../../../electron/main/services/mcp-stdio-server.service';
import type {
  AnyMcpTool,
  McpCallCtx,
  ServerInfo,
} from '../../../electron/main/services/mcp-host.service';

const serverInfo: ServerInfo = { name: 'test', version: '0', protocolVersion: '2024-11-05' };

const dirs: string[] = [];
const sockets: Socket[] = [];
let server: StdioSocketServer | null = null;

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  if (server) {
    await server.close().catch(() => undefined);
    server = null;
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// 返回本次调用的 callerSubject,测试据此知道每条连接的 subject。
const subjectTool: AnyMcpTool = {
  name: 'whoami',
  description: 'return caller subject',
  jsonSchema: { type: 'object', additionalProperties: false },
  inputSchema: z.object({}).strict(),
  run: (_input: unknown, ctx: McpCallCtx) => ({ subject: ctx.callerSubject }),
};

async function connectAndGetSubject(socketPath: string): Promise<{ socket: Socket; subject: string }> {
  const socket = createConnection(socketPath);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const line = new Promise<Record<string, unknown>>((resolve) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx >= 0) resolve(JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>);
    });
  });
  socket.write(
    JSON.stringify({ jsonrpc: '2.0', method: '_continuo/hello', params: { windowId: 7, token: 'tok' } }) + '\n',
  );
  socket.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) + '\n',
  );
  const response = await line;
  const result = response['result'] as { content: Array<{ text: string }> };
  const { subject } = JSON.parse(result.content[0]!.text) as { subject: string };
  return { socket, subject };
}

describe.skipIf(process.platform === 'win32')('50 · stdio 连接断开回收该调用方的 debug 会话', () => {
  it('连接 close → onCallerClosed 收到该连接的 callerSubject;其它连接不受影响', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'continuo-stdio-closed-'));
    dirs.push(dir);
    const socketPath = path.join(dir, 'mcp.sock');
    const onCallerClosed = vi.fn();
    server = await createStdioSocketServer({
      socketPath,
      tools: new Map([['whoami', subjectTool]]),
      serverInfo,
      resolveWindowId: () => 7,
      onCallerClosed,
    });

    const a = await connectAndGetSubject(socketPath);
    const b = await connectAndGetSubject(socketPath);
    expect(a.subject).not.toBe(b.subject);

    a.socket.destroy();
    await vi.waitFor(() => expect(onCallerClosed).toHaveBeenCalledWith(a.subject));
    expect(onCallerClosed).toHaveBeenCalledTimes(1);
    expect(onCallerClosed).not.toHaveBeenCalledWith(b.subject);
  });

  it('从未发起调用的连接(未分配 subject)断开 → 不回调', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'continuo-stdio-closed-'));
    dirs.push(dir);
    const socketPath = path.join(dir, 'mcp.sock');
    const onCallerClosed = vi.fn();
    const closed = vi.fn();
    server = await createStdioSocketServer({
      socketPath,
      tools: new Map(),
      serverInfo,
      resolveWindowId: () => 7,
      onCallerClosed,
    });
    const socket = createConnection(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.once('close', closed);
    socket.destroy();
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    // 服务端 close 事件稍后于客户端;给它一个事件循环。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onCallerClosed).not.toHaveBeenCalled();
  });
});
