// race(R75):MCP HTTP 请求只在 await readBody(req) 之前校验一次 bearer token。readBody/parse
// 期间(可较慢)若 rotateToken()/revoke 发生(用户撤销 agent 授权),旧 ctx 已失效但仍被
// dispatchRpc 复用 → 撤销后、body 未发完的旧 token 请求仍能调工具。修复:dispatch 前重校验。
//
// 本测试用 node:http 把 body 分两段发,在两段之间 rotateToken,确定性触发 readBody 窗口竞态:
// 不修则旧 ctx 复用 → 工具执行 + 200;修后 → 重校验失败 → 401 + 工具不执行。

import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createMcpHost,
  type McpHost,
  type AnyMcpTool,
} from '../../../electron/main/services/mcp-host.service';

let host: McpHost | null = null;
afterEach(async () => {
  if (host) await host.close();
  host = null;
});

describe('race(R75) · MCP host readBody 期间 rotateToken → dispatch 前重校验', () => {
  it('body 读取期间 token 被 rotate → 返回 401 且工具不执行', async () => {
    let invoked = false;
    const tool: AnyMcpTool = {
      name: 'r75.tool',
      description: 'records invocation',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => {
        invoked = true;
        return { ok: true };
      },
    };
    host = await createMcpHost({ initialTools: [tool] });
    const token = host.issueWindowToken(1);
    const url = new URL(host.url);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'r75',
      method: 'tools/call',
      params: { name: 'r75.tool', arguments: {} },
    });
    const half = Math.floor(body.length / 2);

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          res.resume(); // drain body
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      // 先发一半 body → server 进入 await readBody;
      req.write(body.slice(0, half));
      setTimeout(() => {
        // body 读取期间撤销授权:rotate 使旧 token 失效。
        host!.rotateToken();
        req.write(body.slice(half));
        req.end();
      }, 50);
    });

    // dispatch 前重校验:旧 token 已失效 → 401,工具绝不执行。
    expect(status).toBe(401);
    expect(invoked).toBe(false);
  });

  // race(R76):revokeToken/revokeWindowTokens 只删 windowTokens,不关已建立的 SSE 连接 →
  // 撤销后旧 client 仍 keepalive + 收 broadcast(stale 连接 + interval 泄漏)。修复:revoke 同步
  // end 匹配的 SSE。
  it('revokeToken 关闭该 token 的 SSE 连接(撤销后不再收 broadcast)', async () => {
    host = await createMcpHost({});
    const token = host.issueWindowToken(1);
    const url = new URL(host.url);

    // 建立 SSE 连接(GET /mcp + SSE accept)。
    const events: string[] = [];
    const sseClosed = new Promise<void>((resolveClosed) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          res.setEncoding('utf-8');
          res.on('data', (c: string) => events.push(c));
          res.on('end', () => resolveClosed());
          res.on('close', () => resolveClosed());
        },
      );
      req.on('error', () => resolveClosed());
      req.end();
    });

    // 等 SSE ready 事件到达(连接已进 sseClients)。
    await vi.waitFor(() => {
      if (!events.some((e) => e.includes('ready'))) throw new Error('no ready');
    });

    // 撤销该 token → 应 end 掉这条 SSE。
    host.revokeToken(token);

    // SSE 连接被服务端关闭(end/close 触发)。若未修,连接保持开放,sseClosed 永不 resolve。
    await sseClosed;
  });

  // race(R112,R111 同源 HTTP 侧):client 在 tool call 在途时断开 → server 端 abort 本请求,
  // ctx.signal.aborted 置真,供有副作用工具(create_session)在授权后复查跳过副作用。
  it('R112 client 断开在途 call → ctx.signal aborted', async () => {
    let started = false;
    let sawAbort: boolean | null = null;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tool: AnyMcpTool = {
      name: 'r112.slow',
      description: 'awaits gate then reports ctx.signal.aborted',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: async (_input, ctx) => {
        started = true;
        await gate; // 模拟卡在用户授权 await
        sawAbort = ctx.signal?.aborted ?? null;
        return { ok: true };
      },
    };
    host = await createMcpHost({ initialTools: [tool] });
    const token = host.issueWindowToken(1);
    const url = new URL(host.url);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'r112',
      method: 'tools/call',
      params: { name: 'r112.slow', arguments: {} },
    });
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      },
    });
    req.on('error', () => {}); // 主动 destroy 会触发 error,吞掉
    req.end(body);

    // 等 server 进入 tool.run(在途)。
    await vi.waitFor(() => {
      if (!started) throw new Error('not started');
    });
    req.destroy(); // client 断开
    await new Promise((r) => setTimeout(r, 50)); // 让 server 处理 req 'close' → abort
    release(); // 放行 run → 复查 ctx.signal
    await vi.waitFor(() => {
      if (sawAbort === null) throw new Error('no result');
    });
    expect(sawAbort).toBe(true);
  });

  it('无 rotate 的正常请求仍 200 且工具执行(契约保持)', async () => {
    let invoked = false;
    const tool: AnyMcpTool = {
      name: 'r75.ok',
      description: 'ok',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => {
        invoked = true;
        return { ok: true };
      },
    };
    host = await createMcpHost({ initialTools: [tool] });
    const token = host.issueWindowToken(1);
    const res = await fetch(host.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ok',
        method: 'tools/call',
        params: { name: 'r75.ok', arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    expect(invoked).toBe(true);
  });
});
