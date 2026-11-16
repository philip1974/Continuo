// 退出时在途 HTTP MCP 请求不得拖住 mcpHost.close()。HTTP 客户端调用需首次授权的工具后保持连接、不应答
// 弹窗;Cmd+Q 时窗口已隐藏,before-quit await mcpHost.close(),而 server.close() 只停止接新连接、要等
// 现存连接自行结束 → 请求挂在 5 分钟授权定时器上 → 应用不可见且 5 分钟无法退出。
// 修复:close() 主动断开现存连接(在途请求被拒:客户端收到连接断开,服务端 ctx.signal abort),
// 并为整个关闭设上限超时。before-quit 另先同步拒绝所有未决 agent 授权(见 agent-auth-service T17)。

import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createMcpHost,
  type AnyMcpTool,
  type McpHost,
} from '../../../electron/main/services/mcp-host.service';

let host: McpHost | null = null;
afterEach(async () => {
  if (host) await host.close();
  host = null;
});

describe('49 · mcpHost.close() 不被挂在授权上的在途 HTTP 请求拖住', () => {
  it('在途 tools/call 永不返回 → close() 有界完成,请求被断开,服务端收到 abort', async () => {
    let started = false;
    let signal: AbortSignal | undefined;
    const tool: AnyMcpTool = {
      name: 'quit.pendingAuth',
      description: 'never settles (simulates awaiting user auth)',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: (_input, ctx) => {
        started = true;
        signal = ctx.signal;
        return new Promise(() => undefined); // 模拟等授权弹窗(5 分钟定时器)
      },
    };
    host = await createMcpHost({ initialTools: [tool] });
    const token = host.issueWindowToken(1);
    const url = new URL(host.url);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'quit',
      method: 'tools/call',
      params: { name: 'quit.pendingAuth', arguments: {} },
    });
    // keep-alive agent:模拟保持连接的真实 MCP 客户端
    const agent = new http.Agent({ keepAlive: true });
    const outcome = new Promise<string>((resolve) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          agent,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          res.resume();
          resolve(`status:${res.statusCode}`);
        },
      );
      req.on('error', (e: NodeJS.ErrnoException) => resolve(`error:${e.code ?? e.message}`));
      req.end(body);
    });
    await vi.waitFor(() => {
      if (!started) throw new Error('not started');
    });

    const t0 = Date.now();
    const h = host;
    host = null;
    await h.close();
    expect(Date.now() - t0).toBeLessThan(3000);
    // 请求被拒(连接断开),不是挂到授权超时
    expect(await outcome).toMatch(/^error:/);
    // 服务端 req/res 'close' 异步派发 → 在途调用的取消信号随后置位
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    agent.destroy();
  }, 10000);
});
