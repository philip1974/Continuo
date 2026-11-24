// topic 49 第八轮 · P2-W:stdio MCP 连接绑定的窗口关闭后不永久失效。
//
// 根因:socketCtx 在 `_continuo/hello` 时把 socket 一次性绑到某 windowId,窗口
// 关闭清理(revokeWindowTokens/cancelByWindow)不触碰 socketCtx,而 proxy 进程
// 没退、socket 仍连着。旧 dispatch 直接用 socketCtx.get(sock) 的 windowId 构造
// ctx —— 该窗口已死时 ctx 仍非 null,跳过"fallback 到活窗"分支 → 所有 tools/call
// 撞 TERMINAL_NO_WINDOW/SESSION_NOT_FOUND,该 proxy 连接对所有工具永久损坏
// (即使别的窗口活着),直到 proxy 重连。
//
// 修复:resolveStdioCallOwnerWindow 在每次 dispatch 校验绑定窗口存活,死则返回
// null → 走 fallback 到当前活窗。

//
// 安全(F4 后修订):hello 绑定过窗口的连接,绑定窗口关闭后**拒绝**(NO_WINDOW_CTX),不再回落到当前活窗。
// 回落会让窗口 A 里 agent 的调用以窗口 B 的身份执行 / 弹授权(B 已 session 授权 → 静默放行)。未发 hello 的
// 外部客户端保持既有行为(回落到第一个非 popout 主窗)。hello 本身失败(token 无效 / 窗口已关)同样拒绝。

import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

const win = vi.hoisted(() => ({ alive: new Set<number>() }));
vi.mock('electron', () => ({
  BrowserWindow: {
    fromId: vi.fn((id: number) => (win.alive.has(id) ? { isDestroyed: () => false } : null)),
    getAllWindows: vi.fn(() =>
      [...win.alive].map((id) => ({
        id,
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, getURL: () => 'file:///renderer/index.html' },
      })),
    ),
  },
}));

import {
  createStdioSocketServer,
  resolveStdioCallOwnerWindow,
  type StdioSocketServer,
} from '../../../electron/main/services/mcp-stdio-server.service';
import type {
  AnyMcpTool,
  McpCallCtx,
  ServerInfo,
} from '../../../electron/main/services/mcp-host.service';

describe('topic49 P2-W · stdio 绑定窗口死后不卡死', () => {
  it('绑定窗口存活 → 返回该 windowId', () => {
    const r = resolveStdioCallOwnerWindow(7, { isWindowAlive: (id) => id === 7 });
    expect(r).toBe(7);
  });

  it('绑定窗口已关闭 → 返回 null(交给 fallback)', () => {
    const r = resolveStdioCallOwnerWindow(7, { isWindowAlive: () => false });
    expect(r).toBeNull();
  });

  it('未绑定(undefined,无 hello 的外部 proxy)→ 返回 null', () => {
    let probed = false;
    const r = resolveStdioCallOwnerWindow(undefined, {
      isWindowAlive: () => {
        probed = true;
        return true;
      },
    });
    expect(r).toBeNull();
    // 未绑定时不应去探测窗口存活
    expect(probed).toBe(false);
  });

  it('windowId=0(合法 id)且存活 → 返回 0,不被当作 falsy 丢弃', () => {
    const r = resolveStdioCallOwnerWindow(0, { isWindowAlive: (id) => id === 0 });
    expect(r).toBe(0);
  });
});

// ── 端到端(真 unix socket):hello 绑定窗口关闭 → fail-closed ──────────────

const serverInfo: ServerInfo = { name: 'test', version: '0', protocolVersion: '2024-11-05' };
const dirs: string[] = [];
const sockets: Socket[] = [];
let server: StdioSocketServer | null = null;

afterEach(async () => {
  for (const sk of sockets.splice(0)) sk.destroy();
  if (server) {
    await server.close().catch(() => undefined);
    server = null;
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  win.alive.clear();
});

async function startServer(run: AnyMcpTool['run']): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'continuo-stdio-stale-'));
  dirs.push(dir);
  const socketPath = path.join(dir, 'mcp.sock');
  const tool: AnyMcpTool = {
    name: 'whoami',
    description: 'return owner window',
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run,
  };
  server = await createStdioSocketServer({
    socketPath,
    tools: new Map([['whoami', tool]]),
    serverInfo,
    resolveWindowId: (token) => (token === 'tok7' ? 7 : null),
  });
  return socketPath;
}

async function connect(socketPath: string): Promise<{
  socket: Socket;
  next: () => Promise<Record<string, unknown>>;
}> {
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
  return {
    socket,
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise((resolve) => waiters.push(resolve)),
  };
}

function send(socket: Socket, msg: Record<string, unknown>): void {
  socket.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

describe.skipIf(process.platform === 'win32')('F4 · hello 绑定窗口关闭后 fail-closed', () => {
  it('绑定窗口存活 → 以绑定窗口执行;关闭后 → NO_WINDOW_CTX,不回落到其它活窗、不执行工具', async () => {
    win.alive.add(3);
    win.alive.add(7);
    const run = vi.fn((_i: unknown, ctx: McpCallCtx) => ({ owner: ctx.ownerWindowId }));
    const socketPath = await startServer(run);
    const c = await connect(socketPath);
    send(c.socket, { method: '_continuo/hello', params: { windowId: 7, token: 'tok7' } });
    send(c.socket, { id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const r1 = await c.next();
    expect(r1['error']).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1].ownerWindowId).toBe(7);
    expect(run.mock.calls[0]![1].external).toBeUndefined(); // hello 绑定的终端 agent 不是外部客户端

    win.alive.delete(7); // 绑定窗口关闭,窗口 3 仍活着
    send(c.socket, { id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const r2 = await c.next();
    expect((r2['error'] as { code: number }).code).toBe(-32002);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('hello 失败(token 无效 / 已轮换)→ 不回落主窗,tools/call 回 NO_WINDOW_CTX 且不执行工具', async () => {
    win.alive.add(3);
    win.alive.add(7);
    const run = vi.fn((_i: unknown, ctx: McpCallCtx) => ({ owner: ctx.ownerWindowId }));
    const socketPath = await startServer(run);
    const c = await connect(socketPath);
    send(c.socket, { method: '_continuo/hello', params: { windowId: 7, token: 'rotated-token' } });
    send(c.socket, { id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const r = await c.next();
    expect((r['error'] as { code: number }).code).toBe(-32002);
    expect(run).not.toHaveBeenCalled();
  });

  it('hello 到达前绑定窗口已关 → 同样 NO_WINDOW_CTX,不借主窗授权', async () => {
    win.alive.add(3); // 窗口 7 已关,只剩主窗 3
    const run = vi.fn((_i: unknown, ctx: McpCallCtx) => ({ owner: ctx.ownerWindowId }));
    const socketPath = await startServer(run);
    const c = await connect(socketPath);
    send(c.socket, { method: '_continuo/hello', params: { windowId: 7, token: 'tok7' } });
    send(c.socket, { id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const r = await c.next();
    expect((r['error'] as { code: number }).code).toBe(-32002);
    expect(run).not.toHaveBeenCalled();
  });

  // 安全(F2):回落的 ctx 带 external=true,授权走独立的 external 状态,不借主窗的「本次启动期间允许」。
  it('未发 hello 的外部客户端 → 回落到第一个非 popout 主窗,且 ctx 标记 external', async () => {
    win.alive.add(3);
    const run = vi.fn((_i: unknown, ctx: McpCallCtx) => ({ owner: ctx.ownerWindowId }));
    const socketPath = await startServer(run);
    const c = await connect(socketPath);
    send(c.socket, { id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const r = await c.next();
    expect(r['error']).toBeUndefined();
    expect(run.mock.calls[0]![1].ownerWindowId).toBe(3);
    expect(run.mock.calls[0]![1].external).toBe(true);
  });
});
